use axum::body::Bytes;
use regex::Regex;
use reqwest::{Client, Response, Url, header};
use serde_json::{Value, json};
use std::{sync::LazyLock, time::Duration};
use tokio::time::sleep;

pub const CHAT: &str = "https://chat.deepseek.com";
pub const PLATFORM: &str = "https://platform.deepseek.com";
pub type Result<T> = std::result::Result<T, &'static str>;
const UA: &str = "Mozilla/5.0 Chrome/137.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const KEY_NAME: &str = include_str!("../../shared/platformKeyName.json");

pub enum Login {
    Chat,
    Platform,
}

impl Login {
    fn config(&self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::Chat => (CHAT, "/api/v0/users", "wx932d4fdaf46d5611"),
            Self::Platform => (PLATFORM, "/auth-api/v0/users", "wx335255e1b73f9e52"),
        }
    }
}

pub fn client() -> reqwest::Result<Client> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .build()
}

fn rate_limit(response: &Response) -> Result<()> {
    if response.status().as_u16() == 429 {
        return Err("rateLimit");
    }
    Ok(())
}

pub async fn qr(client: &Client, login: &Login) -> Result<(String, Bytes, String)> {
    static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/connect/qrcode/([\w-]+)").unwrap());
    let (origin, path, appid) = login.config();
    let callback = format!("{origin}{path}/oauth/wechat/callback");
    let response = client
        .get("https://open.weixin.qq.com/connect/qrconnect")
        .header(header::USER_AGENT, UA)
        .timeout(REQUEST_TIMEOUT)
        .query(&[
            ("appid", appid),
            ("redirect_uri", &callback),
            ("response_type", "code"),
            ("scope", "snsapi_login"),
            ("login_type", "jssdk"),
            ("self_redirect", "false"),
            ("state", ""),
        ])
        .send()
        .await
        .map_err(|_| "upstream")?;
    rate_limit(&response)?;
    if !response.status().is_success() {
        return Err("upstream");
    }
    let html = response.text().await.map_err(|_| "upstream")?;
    let id = ID.captures(&html).ok_or("upstream")?[1].to_owned();
    let response = client
        .get(format!("https://open.weixin.qq.com/connect/qrcode/{id}"))
        .header(header::USER_AGENT, UA)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| "upstream")?;
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !response.status().is_success()
        || !matches!(
            content_type.split(';').next(),
            Some("image/png" | "image/jpeg")
        )
    {
        return Err("upstream");
    }
    let content_type = content_type.to_owned();
    let image = response.bytes().await.map_err(|_| "upstream")?;
    Ok((id, image, content_type))
}

#[derive(Debug, PartialEq)]
enum Scan<'a> {
    Pending(&'a str),
    Expired,
    Authorized(&'a str),
}

fn scan_status(body: &str) -> Result<Scan<'_>> {
    static STATUS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\bwx_errcode\s*=\s*(\d+)").unwrap());
    static CODE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"\bwx_code\s*=\s*['"]([\w-]+)['"]"#).unwrap());
    let status = STATUS
        .captures(body)
        .and_then(|m| m.get(1))
        .ok_or("upstream")?
        .as_str();
    match status {
        "405" => Ok(Scan::Authorized(
            CODE.captures(body)
                .and_then(|m| m.get(1))
                .ok_or("upstream")?
                .as_str(),
        )),
        "402" | "500" => Ok(Scan::Expired),
        "403" | "404" | "408" => Ok(Scan::Pending(status)),
        _ => Err("upstream"),
    }
}

pub async fn wait_for_scan(client: &Client, id: &str) -> Result<Option<String>> {
    let mut last = String::new();
    loop {
        let mut request = client
            .get("https://long.open.weixin.qq.com/connect/l/qrconnect")
            .header(header::USER_AGENT, UA)
            .timeout(Duration::from_secs(45))
            .query(&[("uuid", id)]);
        if !last.is_empty() {
            request = request.query(&[("last", &last)]);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) if error.is_timeout() => continue,
            Err(_) => return Err("upstream"),
        };
        rate_limit(&response)?;
        if !response.status().is_success() {
            return Err("upstream");
        }
        let body = response.text().await.map_err(|_| "upstream")?;
        match scan_status(&body)? {
            Scan::Authorized(code) => return Ok(Some(code.to_owned())),
            Scan::Expired => return Ok(None),
            Scan::Pending(status) => {
                last = status.to_owned();
                sleep(Duration::from_millis(if status == "404" {
                    100
                } else {
                    2000
                }))
                .await;
            }
        }
    }
}

fn oauth_redirect(origin: &str, status: u16, location: &str) -> Result<(Url, String)> {
    let redirect = Url::parse(origin)
        .unwrap()
        .join(location)
        .map_err(|_| "unauthorized")?;
    let nonce = redirect
        .query_pairs()
        .find(|(key, _)| key == "nonce")
        .map(|(_, value)| value.into_owned());
    if !(300..400).contains(&status)
        || redirect.origin().ascii_serialization() != origin
        || !redirect
            .query_pairs()
            .any(|(key, value)| key == "provider" && value == "WECHAT")
    {
        return Err("unauthorized");
    }
    Ok((
        redirect,
        nonce
            .filter(|value| !value.is_empty())
            .ok_or("unauthorized")?,
    ))
}

pub async fn exchange(client: &Client, login: &Login, code: &str) -> Result<String> {
    let (origin, path, _) = login.config();
    let response = client
        .get(format!("{origin}{path}/oauth/wechat/callback"))
        .header(header::USER_AGENT, UA)
        .timeout(REQUEST_TIMEOUT)
        .query(&[("code", code), ("state", "")])
        .send()
        .await
        .map_err(|_| "upstream")?;
    rate_limit(&response)?;
    let location = response
        .headers()
        .get(header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let (redirect, nonce) = oauth_redirect(origin, response.status().as_u16(), location)?;
    drop(response);
    let response = client
        .post(format!("{origin}{path}/oauth/get_token"))
        .header(header::USER_AGENT, UA)
        .header(header::ORIGIN, origin)
        .header(header::REFERER, redirect.as_str())
        .timeout(REQUEST_TIMEOUT)
        .json(&json!({ "nonce": nonce, "provider": "WECHAT" }))
        .send()
        .await
        .map_err(|_| "upstream")?;
    let data = api_data(response, "unauthorized", "unauthorized").await?;
    if data["biz_code"].as_i64() != Some(0) {
        return Err("unauthorized");
    }
    data["biz_data"]["token"]
        .as_str()
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .ok_or("unauthorized")
}

async fn api_data(
    response: Response,
    unauthorized: &'static str,
    failure: &'static str,
) -> Result<Value> {
    rate_limit(&response)?;
    let status = response.status();
    if status.as_u16() == 401 {
        return Err(unauthorized);
    }
    let data: Value = response.json().await.map_err(|_| failure)?;
    match data["code"].as_i64() {
        Some(40002 | 40003) => Err(unauthorized),
        Some(40029) => Err("rateLimit"),
        Some(0) if status.is_success() => Ok(data
            .get("data")
            .cloned()
            .filter(Value::is_object)
            .ok_or(failure)?),
        _ => Err(failure),
    }
}

async fn export_request(client: &Client, token: &str, path: &str) -> Result<Value> {
    let response = client
        .get(format!("{CHAT}/api/v0/{path}"))
        .bearer_auth(token)
        .header(header::USER_AGENT, UA)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| "upstream")?;
    api_data(response, "unauthorized", "upstream").await
}

#[derive(Debug, PartialEq)]
pub enum Export {
    Empty,
    Pending,
    Ready(Url),
}

fn archive_target(value: &str) -> Result<Url> {
    static HOST: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^[a-z0-9.-]+\.[a-z]{2,}$").unwrap());
    let url = Url::parse(value).map_err(|_| "upstream")?;
    let host = url.host_str().unwrap_or("");
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !HOST.is_match(host)
        || ["local", "localhost", "internal"].contains(&host.rsplit('.').next().unwrap_or(""))
    {
        return Err("upstream");
    }
    Ok(url)
}

fn export_status(data: &Value) -> Result<Export> {
    match data["biz_code"].as_i64() {
        Some(1 | 2) => Ok(Export::Empty),
        Some(0) => match data["biz_data"]["status"].as_str() {
            Some("INIT" | "CREATED" | "PENDING") => Ok(Export::Pending),
            Some("FINISHED") => Ok(Export::Ready(archive_target(
                data["biz_data"]["history_download_url"]
                    .as_str()
                    .ok_or("upstream")?,
            )?)),
            _ => Err("upstream"),
        },
        _ => Err("upstream"),
    }
}

pub async fn history_export(client: &Client, token: &str, start: bool) -> Result<Export> {
    let status = export_status(&export_request(client, token, "download_export_history").await?)?;
    if status != Export::Empty || !start {
        return Ok(status);
    }
    let data = export_request(client, token, "export_all").await?;
    match data["biz_code"].as_i64() {
        Some(0) => Ok(Export::Pending),
        Some(1) => {
            let status =
                export_status(&export_request(client, token, "download_export_history").await?)?;
            if status == Export::Empty {
                return Err("exportRateLimit");
            }
            Ok(status)
        }
        _ => Err("upstream"),
    }
}

fn platform_failure(
    status: u16,
    code: Option<i64>,
    biz_code: Option<i64>,
    stage: &'static str,
) -> Result<()> {
    if status == 401 || matches!(code, Some(40002 | 40003)) {
        return Err("platformSignIn");
    }
    if status == 429 || code == Some(40029) {
        return Err("rateLimit");
    }
    if !(200..300).contains(&status) || code != Some(0) {
        return Err(stage);
    }
    match (stage, biz_code) {
        (_, Some(0)) => Ok(()),
        ("platformKey", Some(8)) => Err("platformIdentity"),
        ("platformKey", Some(1)) => Err("platformKeyLimit"),
        _ => Err(stage),
    }
}

fn platform_key_request(
    client: &Client,
    token: &str,
    path: &str,
    data: Option<Value>,
) -> reqwest::RequestBuilder {
    let url = format!("{PLATFORM}/api/v0/users/{path}");
    let request = match data {
        Some(data) => client.post(url).json(&data),
        None => client.get(url),
    };
    request
        .bearer_auth(token)
        .header(header::USER_AGENT, UA)
        .header(header::ORIGIN, PLATFORM)
        .header(header::REFERER, format!("{PLATFORM}/api_keys"))
        .timeout(REQUEST_TIMEOUT)
}

async fn platform_request(
    client: &Client,
    token: &str,
    path: &str,
    data: Option<Value>,
) -> Result<Value> {
    let stage = match data.as_ref().and_then(|data| data["action"].as_str()) {
        Some("delete") => "platformDelete",
        Some("create") => "platformKey",
        _ => "platformList",
    };
    let response = platform_key_request(client, token, path, data)
        .send()
        .await
        .map_err(|_| {
            eprintln!("DeepSeek API key operation {stage}: transport error");
            stage
        })?;
    let status = response.status().as_u16();
    let response_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or("")
        .to_owned();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    let code = body["code"].as_i64();
    let biz_code = body["data"]["biz_code"].as_i64();
    if let Err(error) = platform_failure(status, code, biz_code, stage) {
        eprintln!(
            "DeepSeek API key operation {stage}: HTTP {status}, code {code:?}, biz_code {biz_code:?}"
        );
        if status == 422 {
            let fields = [
                "action",
                "name",
                "redacted_key",
                "tracking_id",
                "created_at",
                "is_exp",
            ];
            let details = body["detail"].as_array().map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let field = item["loc"]
                            .as_array()?
                            .iter()
                            .rev()
                            .find_map(|value| value.as_str().filter(|field| fields.contains(field)))
                            .unwrap_or("unknown");
                        let kind = item["type"]
                            .as_str()
                            .filter(|kind| kind.len() < 60 && kind.bytes().all(token_char))
                            .unwrap_or("unknown");
                        Some((field, kind))
                    })
                    .collect::<Vec<_>>()
            });
            eprintln!(
                "DeepSeek API key validation {stage}: type {response_type}, fields {details:?}, JSON detail {}",
                body.get("detail").is_some()
            );
        }
        return Err(error);
    }
    Ok(body["data"]["biz_data"].clone())
}

pub async fn list_keys(client: &Client, token: &str) -> Result<Vec<Value>> {
    let data = platform_request(client, token, "get_api_keys", None).await?;
    data["api_keys"].as_array().cloned().ok_or_else(|| {
        eprintln!("DeepSeek API key operation platformList: API key list missing");
        "platformList"
    })
}

pub async fn revoke_app_keys(client: &Client, token: &str, keys: &[Value]) -> Result<()> {
    let name = serde_json::from_str::<&str>(KEY_NAME).map_err(|_| "platformKey")?;
    let previous: Vec<_> = keys
        .iter()
        .filter(|key| key["name"] == name && key["key_type"] != "DSH")
        .collect();
    if previous.iter().any(|key| {
        key["sensitive_id"].as_str().is_none_or(str::is_empty) || !key["created_at"].is_number()
    }) {
        eprintln!("DeepSeek API key operation platformDelete: existing key metadata missing");
        return Err("platformDelete");
    }
    for key in previous {
        let tracking_id = key["tracking_id"].as_str().filter(|value| *value != "null");
        let created_at = &key["created_at"];
        let timestamp = created_at
            .as_f64()
            .filter(|value| value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0)
            .map_or_else(|| created_at.clone(), |value| json!(value as i64));
        platform_request(client, token, "edit_api_keys", Some(json!({
            "action": "delete", "name": null, "redacted_key": key["sensitive_id"], "tracking_id": tracking_id,
            "created_at": timestamp,
        }))).await?;
    }
    Ok(())
}

pub async fn rotate_key(client: &Client, token: &str, keys: &[Value]) -> Result<String> {
    revoke_app_keys(client, token, keys).await?;
    let name = serde_json::from_str::<&str>(KEY_NAME).map_err(|_| "platformKey")?;
    let data = platform_request(
        client,
        token,
        "edit_api_keys",
        Some(json!({
            "action": "create", "name": name, "redacted_key": null, "tracking_id": null,
            "created_at": null, "is_exp": false,
        })),
    )
    .await?;
    data["api_key"]["sensitive_id"]
        .as_str()
        .filter(|key| {
            key.strip_prefix("sk-")
                .is_some_and(|value| value.len() >= 24 && value.bytes().all(token_char))
        })
        .map(str::to_owned)
        .ok_or_else(|| {
            eprintln!(
                "DeepSeek API key operation platformKey: created key missing or unsupported format"
            );
            "platformKey"
        })
}

pub fn token_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_mutations_send_one_json_content_type() {
        let client = client().unwrap();
        for action in ["delete", "create"] {
            let request = platform_key_request(
                &client,
                "fixture-token",
                "edit_api_keys",
                Some(json!({"action": action})),
            )
            .build()
            .unwrap();
            assert_eq!(
                request
                    .headers()
                    .get_all(header::CONTENT_TYPE)
                    .iter()
                    .count(),
                1
            );
            assert_eq!(request.headers()[header::CONTENT_TYPE], "application/json");
            assert_eq!(
                serde_json::from_slice::<Value>(request.body().unwrap().as_bytes().unwrap())
                    .unwrap()["action"],
                action
            );
        }
        let duplicate = client
            .post(PLATFORM)
            .json(&json!({}))
            .header(header::CONTENT_TYPE, "application/json")
            .build()
            .unwrap();
        assert_eq!(
            duplicate
                .headers()
                .get_all(header::CONTENT_TYPE)
                .iter()
                .count(),
            2
        );
    }

    #[test]
    fn distinguishes_platform_authentication_and_key_operations() {
        assert_eq!(
            platform_failure(401, None, None, "platformList"),
            Err("platformSignIn")
        );
        assert_eq!(
            platform_failure(200, Some(40003), None, "platformList"),
            Err("platformSignIn")
        );
        assert_eq!(
            platform_failure(200, Some(0), Some(8), "platformKey"),
            Err("platformIdentity")
        );
        assert_eq!(
            platform_failure(200, Some(0), Some(1), "platformKey"),
            Err("platformKeyLimit")
        );
        assert_eq!(
            platform_failure(200, Some(0), Some(1), "platformDelete"),
            Err("platformDelete")
        );
        assert_eq!(
            platform_failure(200, Some(0), Some(0), "platformKey"),
            Ok(())
        );
    }

    #[test]
    fn reads_wechat_poll_results() {
        assert_eq!(
            scan_status("window.wx_errcode=405;window.wx_code='a-b';"),
            Ok(Scan::Authorized("a-b"))
        );
        assert_eq!(
            scan_status("window.wx_errcode=404;"),
            Ok(Scan::Pending("404"))
        );
        assert_eq!(scan_status("window.wx_errcode=402;"), Ok(Scan::Expired));
        assert!(scan_status("window.wx_errcode=405;").is_err());
    }

    #[test]
    fn oauth_nonce_stays_on_expected_origin() {
        assert!(oauth_redirect(CHAT, 302, "/sign_in?nonce=abc&provider=WECHAT").is_ok());
        assert!(
            oauth_redirect(
                CHAT,
                302,
                "https://other.example/?nonce=abc&provider=WECHAT"
            )
            .is_err()
        );
        assert!(oauth_redirect(CHAT, 302, "/sign_in?nonce=abc&provider=OTHER").is_err());
        assert!(oauth_redirect(CHAT, 200, "/sign_in?nonce=abc&provider=WECHAT").is_err());
    }

    #[test]
    fn export_status_and_download_target_validation() {
        assert_eq!(export_status(&json!({"biz_code": 1})), Ok(Export::Empty));
        assert_eq!(
            export_status(&json!({"biz_code": 0, "biz_data": {"status": "PENDING"}})),
            Ok(Export::Pending)
        );
        let url = "https://archive.example.com/history.zip?signature=abc";
        assert_eq!(
            export_status(
                &json!({"biz_code": 0, "biz_data": {"status": "FINISHED", "history_download_url": url}})
            ),
            Ok(Export::Ready(Url::parse(url).unwrap()))
        );
        for url in [
            "http://archive.example.com",
            "https://127.0.0.1",
            "https://host.internal",
            "https://user@archive.example.com",
            "https://archive.example.com:8888",
        ] {
            assert!(archive_target(url).is_err(), "{url}");
        }
    }
}
