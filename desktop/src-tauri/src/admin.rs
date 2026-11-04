// Owner requests to a stream server (/api/rooms, /api/usage). Those endpoints have no CORS on
// purpose, so the app's page can't call them; the core makes the request instead. Only those two
// paths, only to a bare https origin (or http://localhost for development), and no redirects, so
// a creator key can't be bounced to anywhere but the server it was given for.

use serde::Serialize;
use std::time::Duration;
use url::Url;

#[derive(Serialize)]
pub struct Reply {
    status: u16,
    body: serde_json::Value,
}

fn check_origin(origin: &str) -> Result<Url, String> {
    let url = Url::parse(origin).map_err(|_| "Not a server address".to_string())?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    let allowed = url.scheme() == "https" || (url.scheme() == "http" && local);
    // Exactly an origin: nothing that could smuggle in another host, path or credentials.
    if !allowed || url.origin().ascii_serialization() != origin {
        return Err("Owner requests only go to https servers".into());
    }
    Ok(url)
}

#[tauri::command]
pub async fn server_request(
    origin: String,
    path: String,
    creator_key: Option<String>,
    body: Option<serde_json::Value>,
) -> Result<Reply, String> {
    let base = check_origin(&origin)?;
    let post = match path.as_str() {
        "/api/rooms" => true,
        "/api/usage" => false,
        _ => return Err("Not an owner request".into()),
    };
    let url = base.join(&path).map_err(|e| e.to_string())?;

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = if post {
        client.post(url).json(&body.unwrap_or(serde_json::Value::Null))
    } else {
        client.get(url)
    };
    if let Some(key) = creator_key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }

    let res = req
        .send()
        .await
        .map_err(|_| format!("Couldn't reach {}", base.host_str().unwrap_or("the server")))?;
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    Ok(Reply {
        status,
        body: serde_json::from_str(&text).unwrap_or(serde_json::Value::Null),
    })
}

#[cfg(test)]
mod tests {
    use super::check_origin;

    #[test]
    fn origins() {
        assert!(check_origin("https://stream.hartwigdev.ca").is_ok());
        assert!(check_origin("http://localhost:5173").is_ok());
        assert!(check_origin("http://example.com").is_err());
        assert!(check_origin("https://stream.hartwigdev.ca/").is_err());
        assert!(check_origin("https://a@stream.hartwigdev.ca").is_err());
        assert!(check_origin("https://stream.hartwigdev.ca/api").is_err());
        assert!(check_origin("file:///etc").is_err());
    }
}
