mod recharge;
mod upstream;

use axum::{
    Json, Router,
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::any,
};
use reqwest::{Client, Url};
use serde_json::{Value, json};
use std::{env, path::PathBuf, sync::Arc, time::Duration};
use tokio::net::TcpListener;
use tower_http::services::ServeDir;
use upstream::{Export, Login};
use uuid::Uuid;

#[derive(Clone)]
struct App {
    client: Client,
    origin: Arc<str>,
}

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn json_response(status: StatusCode, value: Value) -> Response {
    no_store((status, Json(value)).into_response())
}

fn empty(status: StatusCode) -> Response {
    json_response(status, json!({}))
}

fn value<'a>(headers: &'a HeaderMap, key: &str) -> Option<&'a str> {
    headers.get(key).and_then(|value| value.to_str().ok())
}

fn session_token(headers: &HeaderMap) -> Option<&str> {
    value(headers, "authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| {
            !token.is_empty()
                && !token.starts_with("sk-")
                && token.len() <= 4096
                && token.bytes().all(|byte| byte.is_ascii_graphic())
        })
}

fn allowed(app: &App, headers: &HeaderMap) -> bool {
    value(headers, "x-deepseek-local") == Some("1")
        && value(headers, "origin") == Some(&app.origin)
        && value(headers, "sec-fetch-site") != Some("cross-site")
}

fn upstream_error(error: &'static str) -> Response {
    let status = match error {
        "unauthorized" | "wechatAuthorization" | "platformSignIn" => StatusCode::UNAUTHORIZED,
        "rateLimit" | "exportRateLimit" => StatusCode::TOO_MANY_REQUESTS,
        _ => StatusCode::BAD_GATEWAY,
    };
    json_response(status, json!({"error":error}))
}

async fn setup_route(State(app): State<App>, req: Request) -> Response {
    if !allowed(&app, req.headers()) {
        return empty(StatusCode::FORBIDDEN);
    }
    if req.method() != Method::POST {
        return empty(StatusCode::METHOD_NOT_ALLOWED);
    }
    let (parts, body) = req.into_parts();
    let client = &app.client;
    let path = parts.uri.path();
    if matches!(
        path,
        "/api/deepseek-import/qr"
            | "/api/deepseek-import/authorize"
            | "/api/deepseek-import/exchange"
    ) {
        let input = match axum::body::to_bytes(body, 4096).await {
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes).ok(),
            Err(_) => None,
        };
        let Some(input) = input else {
            return empty(StatusCode::BAD_REQUEST);
        };
        let login = match input["target"].as_str() {
            Some("chat") => Login::Chat,
            Some("platform") => Login::Platform,
            _ => return empty(StatusCode::BAD_REQUEST),
        };
        if path.ends_with("/qr") {
            return match upstream::qr(client, &login).await {
                Ok((id, image, content_type)) => no_store(
                    (
                        [
                            (header::CONTENT_TYPE.as_str(), content_type),
                            ("x-wechat-qr-id", id),
                        ],
                        image,
                    )
                        .into_response(),
                ),
                Err(error) => upstream_error(error),
            };
        }
        if path.ends_with("/exchange") {
            let Some(code) = input["code"].as_str().filter(|code| {
                !code.is_empty() && code.len() <= 256 && code.bytes().all(upstream::token_char)
            }) else {
                return empty(StatusCode::BAD_REQUEST);
            };
            return match upstream::exchange(client, &login, code).await {
                Ok(token) => {
                    json_response(StatusCode::OK, json!({"state":"authorized","token":token}))
                }
                Err("unauthorized") => upstream_error("wechatAuthorization"),
                Err(error) => upstream_error(error),
            };
        }
        let Some(id) = input["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 128 && id.bytes().all(upstream::token_char))
        else {
            return empty(StatusCode::BAD_REQUEST);
        };
        return match tokio::time::timeout(
            Duration::from_secs(25),
            upstream::wait_for_scan(client, id),
        )
        .await
        {
            Err(_) => json_response(StatusCode::OK, json!({"state":"pending"})),
            Ok(Ok(None)) => json_response(StatusCode::OK, json!({"state":"expired"})),
            Ok(Ok(Some(code))) => {
                json_response(StatusCode::OK, json!({"state":"scanned","code":code}))
            }
            Ok(Err(error)) => upstream_error(error),
        };
    }
    if !matches!(
        path,
        "/api/deepseek-import/export"
            | "/api/deepseek-import/export/status"
            | "/api/deepseek-import/archive"
            | "/api/deepseek-import/key"
            | "/api/deepseek-import/revoke-key"
    ) {
        return empty(StatusCode::NOT_FOUND);
    }
    let Some(token) = session_token(&parts.headers) else {
        return upstream_error("unauthorized");
    };
    if matches!(
        path,
        "/api/deepseek-import/key" | "/api/deepseek-import/revoke-key"
    ) {
        let keys = match upstream::list_keys(client, token).await {
            Ok(keys) => keys,
            Err(error) => return upstream_error(error),
        };
        if path.ends_with("/revoke-key") {
            return match upstream::revoke_app_keys(client, token, &keys).await {
                Ok(()) => empty(StatusCode::OK),
                Err(error) => upstream_error(error),
            };
        }
        let client = client.clone();
        let token = token.to_owned();
        // Complete an in-flight replacement if the HTTP client disconnects.
        return match tokio::spawn(async move { upstream::rotate_key(&client, &token, &keys).await })
            .await
        {
            Ok(Ok(key)) => json_response(StatusCode::OK, json!({"apiKey":key})),
            // Only a rejected list request indicates that signing in again is safe.
            Ok(Err("platformSignIn")) => upstream_error("platformKey"),
            Ok(Err(error)) => upstream_error(error),
            Err(_) => upstream_error("platformKey"),
        };
    }
    let export = upstream::history_export(client, token, path.ends_with("/export")).await;
    match export {
        Ok(Export::Ready(url)) if path.ends_with("/archive") => archive_response(client, url).await,
        Ok(_) if path.ends_with("/archive") => empty(StatusCode::CONFLICT),
        Ok(Export::Ready(url)) => json_response(StatusCode::OK, json!({"archiveUrl":url.as_str()})),
        Ok(Export::Empty) if path.ends_with("/status") => json_response(StatusCode::OK, json!({})),
        Ok(Export::Pending) => json_response(StatusCode::OK, json!({})),
        Ok(Export::Empty) => {
            json_response(StatusCode::CONFLICT, json!({"error":"exportRateLimit"}))
        }
        Err(error) => upstream_error(error),
    }
}

async fn archive_response(client: &Client, url: Url) -> Response {
    match client
        .get(url)
        .header(header::ACCEPT_ENCODING, "identity")
        .timeout(Duration::from_secs(600))
        .send()
        .await
    {
        Ok(response) if response.status() == StatusCode::OK => stream_archive(response),
        _ => upstream_error("upstream"),
    }
}

fn stream_archive(response: reqwest::Response) -> Response {
    let size = match value(response.headers(), "content-encoding") {
        None | Some("identity") => value(response.headers(), "content-length")
            .and_then(|size| size.parse::<u64>().ok())
            .filter(|size| *size > 0),
        _ => None,
    };
    let mut output = Response::new(Body::from_stream(response.bytes_stream()));
    let headers = output.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-transform"),
    );
    headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
    if let Some(size) = size {
        headers.insert("x-archive-size", size.into());
    }
    output
}

fn router(app: App, dist: PathBuf, host: String) -> Router {
    Router::new()
        .fallback_service(ServeDir::new(dist).precompressed_br().precompressed_gzip())
        .layer(middleware::map_response(
            |mut response: Response| async move {
                response
                    .headers_mut()
                    .append(header::VARY, HeaderValue::from_static("accept-encoding"));
                response
            },
        ))
        .route("/api/deepseek-top-up/{*path}", any(recharge::route))
        .route("/api/deepseek-import/{*path}", any(setup_route))
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            let host = host.clone();
            async move {
                let authority = value(req.headers(), "host")
                    .or_else(|| req.uri().authority().map(|host| host.as_str()));
                if authority != Some(&host) {
                    return StatusCode::FORBIDDEN.into_response();
                }
                next.run(req).await
            }
        }))
        .with_state(app)
}

#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let port: u16 = env::var("PORT").unwrap_or_else(|_| "8090".into()).parse()?;
    let host = env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let origin =
        Url::parse(&env::var("APP_ORIGIN").unwrap_or_else(|_| format!("http://127.0.0.1:{port}")))?;
    let authority = origin[url::Position::BeforeHost..url::Position::AfterPort].to_owned();
    let dist = PathBuf::from("dist");
    if !dist.join("index.html").is_file() {
        return Err("Run bun run build before starting the local server.".into());
    }
    let app = App {
        client: upstream::client()?,
        origin: origin.origin().ascii_serialization().into(),
    };
    let listener = TcpListener::bind((host.as_str(), port)).await?;
    println!("DeepSeek chat-demo: {}", app.origin);
    axum::serve(listener, router(app, dist, authority)).await?;
    Ok(())
}

#[cfg(test)]
mod tests;
