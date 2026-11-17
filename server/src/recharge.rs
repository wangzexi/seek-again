use super::*;

const PLATFORM: &str = upstream::PLATFORM;
const USER_AGENT: &str = "Mozilla/5.0 Chrome/137.0.0.0 Safari/537.36";

pub async fn route(State(app): State<App>, req: Request) -> Response {
    if req.method() != Method::POST {
        return empty(StatusCode::METHOD_NOT_ALLOWED);
    }
    if !allowed(&app, req.headers()) {
        return empty(StatusCode::FORBIDDEN);
    }
    let (parts, body) = req.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, 4096).await else {
        return empty(StatusCode::BAD_REQUEST);
    };
    let Ok(input) = serde_json::from_slice::<Value>(&bytes) else {
        return empty(StatusCode::BAD_REQUEST);
    };
    match parts.uri.path() {
        "/api/deepseek-top-up/order" | "/api/deepseek-top-up/status" => {
            let Some(token) = session_token(&parts.headers) else {
                return empty(StatusCode::UNAUTHORIZED);
            };
            if parts.uri.path().ends_with("/order") {
                let Some(order) = order_body(&input) else {
                    return empty(StatusCode::BAD_REQUEST);
                };
                match payment(&app.client, token, "/api/v1/payments", Some(order)).await {
                    Ok(data) => order_response(&data),
                    Err(response) => *response,
                }
            } else {
                let Some(id) = input["id"].as_str().filter(|id| bounded_id(id)) else {
                    return empty(StatusCode::BAD_REQUEST);
                };
                match payment(
                    &app.client,
                    token,
                    &format!("/api/v1/payments/{id}/capture"),
                    None,
                )
                .await
                {
                    Ok(data) => match data["order"]["status"].as_str() {
                        Some("CREATED" | "PENDING") => {
                            json_response(StatusCode::OK, json!({"state":"pending"}))
                        }
                        Some("SUCCESS") => json_response(StatusCode::OK, json!({"state":"paid"})),
                        Some("FAILED" | "REFUNDED" | "CHARGEBACK" | "EXPIRED") => {
                            json_response(StatusCode::OK, json!({"state":"failed"}))
                        }
                        _ => empty(StatusCode::BAD_GATEWAY),
                    },
                    Err(response) => *response,
                }
            }
        }
        _ => empty(StatusCode::NOT_FOUND),
    }
}

fn bounded_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(upstream::token_char)
}

fn order_body(input: &Value) -> Option<Value> {
    let amount = input["amount"]
        .as_u64()
        .filter(|value| matches!(value, 1 | 3 | 5 | 10))?;
    let request = input["requestId"].as_str()?;
    Uuid::parse_str(request).ok()?;
    let (method, fallback) = match input["method"].as_str()? {
        "wechat" => ("CMB_UNIONPAY", Some("WECHAT")),
        "alipay" => ("CMB_UNIONPAY", Some("ALIPAY")),
        "alipayMobile" => ("ALIPAY_WAP", None),
        _ => return None,
    };
    let mut info = json!({
        "payment_method_type": method, "amount": amount.to_string(),
        "currency": "CNY", "request_id": request
    });
    if let Some(fallback) = fallback {
        info["fallback_method_type"] = json!(fallback);
    }
    Some(json!({"order_info": info, "shumei_device_id": null}))
}

fn order_response(data: &Value) -> Response {
    let id = data["payment_order_id"]
        .as_str()
        .filter(|id| bounded_id(id));
    let url = data["url"]
        .as_str()
        .filter(|url| url.len() <= 4096)
        .and_then(|url| Url::parse(url).ok())
        .filter(|url| {
            url.has_host()
                && url.username().is_empty()
                && url.password().is_none()
                && matches!(url.scheme(), "https" | "weixin" | "alipays")
        });
    match (id, url) {
        (Some(id), Some(url)) => {
            let fallback = data["fallback"].as_bool().unwrap_or(false);
            json_response(
                StatusCode::OK,
                json!({"id":id, "url":url.as_str(), "fallback":fallback}),
            )
        }
        _ => empty(StatusCode::BAD_GATEWAY),
    }
}

async fn payment(
    client: &Client,
    token: &str,
    path: &str,
    input: Option<Value>,
) -> std::result::Result<Value, Box<Response>> {
    let mut request = client
        .post(format!("{PLATFORM}{path}"))
        .bearer_auth(token)
        .header(header::USER_AGENT, USER_AGENT)
        .header(header::ORIGIN, PLATFORM)
        .header(header::REFERER, format!("{PLATFORM}/top_up"))
        .timeout(Duration::from_secs(20));
    if let Some(input) = input {
        request = request.json(&input);
    }
    let response = request
        .send()
        .await
        .map_err(|_| Box::new(empty(StatusCode::BAD_GATEWAY)))?;
    let status = response.status();
    if matches!(
        status,
        StatusCode::UNAUTHORIZED | StatusCode::TOO_MANY_REQUESTS
    ) {
        return Err(Box::new(empty(status)));
    }
    let data: Value = response
        .json()
        .await
        .map_err(|_| Box::new(empty(StatusCode::BAD_GATEWAY)))?;
    let code = data["code"].as_i64();
    if matches!(code, Some(40002 | 40003)) {
        return Err(Box::new(empty(StatusCode::UNAUTHORIZED)));
    }
    if code == Some(40029) {
        return Err(Box::new(empty(StatusCode::TOO_MANY_REQUESTS)));
    }
    if !status.is_success() || code != Some(0) {
        return Err(Box::new(empty(StatusCode::BAD_GATEWAY)));
    }
    match data["data"]["biz_code"].as_i64() {
        Some(0) => Ok(data["data"]["biz_data"].clone()),
        Some(8) if path == "/api/v1/payments" => Err(Box::new(json_response(
            StatusCode::FORBIDDEN,
            json!({"error":"identityRequired"}),
        ))),
        Some(1 | 2 | 3 | 6 | 7) if path == "/api/v1/payments" => Err(Box::new(json_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({"error":"orderRejected"}),
        ))),
        Some(2) => Err(Box::new(empty(StatusCode::FORBIDDEN))),
        _ => Err(Box::new(empty(StatusCode::BAD_GATEWAY))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_cny_amount_and_allowlists_methods() {
        let id = Uuid::new_v4().to_string();
        let order =
            order_body(&json!({"amount":10,"requestId":id,"method":"wechat","currency":"USD"}))
                .unwrap();
        assert_eq!(order["order_info"]["currency"], "CNY");
        assert_eq!(order["order_info"]["amount"], "10");
        assert_eq!(order["order_info"]["fallback_method_type"], "WECHAT");
        assert_eq!(order["order_info"]["request_id"], id);
        for (amount, method) in [
            (0, "wechat"),
            (2, "wechat"),
            (11, "wechat"),
            (100, "wechat"),
            (10, "card"),
        ] {
            assert!(order_body(&json!({"amount":amount,"requestId":id,"method":method})).is_none());
        }
        assert!(!bounded_id("../other/capture"));
    }

    #[test]
    fn accepts_provider_urls_and_rejects_script_urls() {
        for (url, status) in [
            ("https://example.com/pay", StatusCode::OK),
            ("weixin://wxpay/bizpayurl?pr=fixture", StatusCode::OK),
            ("javascript:alert(1)", StatusCode::BAD_GATEWAY),
            ("http://example.com/pay", StatusCode::BAD_GATEWAY),
        ] {
            let response = order_response(&json!({"payment_order_id":"test","url":url}));
            assert_eq!(response.status(), status);
            assert_eq!(response.headers()["cache-control"], "no-store");
        }
    }
}
