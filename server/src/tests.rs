use super::*;
use axum::body::Bytes;
use futures_util::StreamExt;
use std::convert::Infallible;
use tokio::sync::Notify;
use tokio::time::timeout;

async fn serve(router: Router) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{address}")
}

async fn test_app() -> (App, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let base = format!("http://{address}");
    let app = App {
        client: upstream::client().unwrap(),
        origin: base.clone().into(),
    };
    let router = router(app.clone(), "../dist".into(), address.to_string());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (app, base)
}

async fn operation(app: &App, method: Method, url: &str) -> reqwest::Response {
    app.client
        .request(method, url)
        .header("x-deepseek-local", "1")
        .header("origin", &*app.origin)
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn enforces_session_headers_and_has_no_model_gateway() {
    let (app, base) = test_app().await;
    let url = format!("{base}/api/deepseek-import/qr");
    assert_eq!(
        app.client.post(&url).send().await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.client
            .post(&url)
            .header("x-deepseek-local", "1")
            .header("origin", "https://other.example")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.client
            .get(&url)
            .header("x-deepseek-local", "1")
            .header("host", "other.example")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        operation(&app, Method::GET, &url).await.status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
    assert_eq!(
        operation(
            &app,
            Method::GET,
            &format!("{base}/api/deepseek/user/balance")
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        operation(
            &app,
            Method::POST,
            &format!("{base}/api/deepseek/anthropic/v1/messages")
        )
        .await
        .status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
}

#[tokio::test]
async fn accepts_only_fixed_operations_and_valid_session_inputs() {
    let (app, base) = test_app().await;
    for (path, status) in [
        (
            "archive?url=http://localhost/private",
            StatusCode::UNAUTHORIZED,
        ),
        ("export/status", StatusCode::UNAUTHORIZED),
        ("key", StatusCode::UNAUTHORIZED),
        ("revoke-key", StatusCode::UNAUTHORIZED),
        ("imported?id=old-job", StatusCode::NOT_FOUND),
        ("skip-api?id=old-job", StatusCode::NOT_FOUND),
    ] {
        let response = operation(
            &app,
            Method::POST,
            &format!("{base}/api/deepseek-import/{path}"),
        )
        .await;
        assert_eq!(response.status(), status);
        assert_eq!(response.headers()["cache-control"], "no-store");
    }
    for (path, body) in [
        ("qr", json!({"target":"https://other.example"})),
        ("authorize", json!({"target":"chat","id":"../invalid"})),
        ("exchange", json!({"target":"chat","code":"../invalid"})),
    ] {
        let response = app
            .client
            .post(format!("{base}/api/deepseek-import/{path}"))
            .header("x-deepseek-local", "1")
            .header("origin", &*app.origin)
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn archive_relay_streams_before_upstream_finishes() {
    let finish = Arc::new(Notify::new());
    let upstream = serve(Router::new().route(
        "/",
        any({
            let finish = finish.clone();
            move || {
                let finish = finish.clone();
                async move {
                    let stream = futures_util::stream::once(async {
                        Ok::<_, Infallible>(Bytes::from_static(b"ZIP1"))
                    })
                    .chain(futures_util::stream::once(async move {
                        finish.notified().await;
                        Ok(Bytes::from_static(b"ZIP2"))
                    }));
                    ([(header::CONTENT_LENGTH, "8")], Body::from_stream(stream))
                }
            }
        }),
    ))
    .await;
    let client = upstream::client().unwrap();
    let response = timeout(
        Duration::from_secs(2),
        archive_response(&client, Url::parse(&upstream).unwrap()),
    )
    .await
    .unwrap();
    assert_eq!(response.headers()["x-archive-size"], "8");
    let mut output = response.into_body().into_data_stream();
    assert_eq!(
        timeout(Duration::from_secs(2), output.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        Bytes::from_static(b"ZIP1")
    );
    finish.notify_one();
    assert_eq!(
        timeout(Duration::from_secs(2), output.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        Bytes::from_static(b"ZIP2")
    );
    assert!(output.next().await.is_none());
}
