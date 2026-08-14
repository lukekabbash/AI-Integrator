use std::{
    io::{ErrorKind, Read, Write},
    net::{IpAddr, TcpListener},
    thread,
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use reqwest::{
    blocking::{Client, RequestBuilder},
    header::{ACCEPT, CONTENT_TYPE, WWW_AUTHENTICATE},
    redirect::Policy,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::{Host, Url};
use zeroize::Zeroizing;

use crate::app_commands::open_external_url;
use crate::command_api::{CommandError, CommandResult};
use crate::credential_store;

const MCP_OAUTH_SERVICE: &str = "dev.aiintegrator.mcp-oauth";
const MCP_PROTOCOL_VERSION: &str = "2025-11-25";
const CALLBACK_PATH: &str = "/oauth/callback";
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const REFRESH_MARGIN_SECONDS: i64 = 60;
const MAX_CALLBACK_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpAuthorizationState {
    Connected,
    NotConnected,
    NeedsAttention,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAuthorization {
    pub state: McpAuthorizationState,
    pub available: bool,
}

#[derive(Clone, Debug, Deserialize)]
struct ProtectedResourceMetadata {
    resource: String,
    #[serde(default)]
    authorization_servers: Vec<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct AuthorizationServerMetadata {
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: Option<String>,
    revocation_endpoint: Option<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
    #[serde(default)]
    token_endpoint_auth_methods_supported: Vec<String>,
    #[serde(default)]
    code_challenge_methods_supported: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct RegistrationResponse {
    client_id: String,
    client_secret: Option<String>,
    token_endpoint_auth_method: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct McpOAuthBundle {
    client_id: String,
    client_secret: Option<String>,
    token_endpoint_auth_method: String,
    token_endpoint: String,
    revocation_endpoint: Option<String>,
    resource: String,
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<i64>,
    scope: Option<String>,
    #[serde(default)]
    needs_attention: bool,
}

struct OAuthDiscovery {
    resource: Url,
    scopes: Vec<String>,
    metadata: AuthorizationServerMetadata,
}

fn oauth_error(code: &'static str, message: impl Into<String>) -> CommandError {
    CommandError {
        code,
        message: message.into(),
    }
}

fn load_bundle(server: &str) -> CommandResult<Option<McpOAuthBundle>> {
    match credential_store::read(MCP_OAUTH_SERVICE, server) {
        Ok(Some(value)) => serde_json::from_str(&value).map(Some).map_err(|_| {
            oauth_error(
                "credential-store-unavailable",
                "The stored MCP authorization could not be read.",
            )
        }),
        Ok(None) => Ok(None),
        Err(_) => Err(oauth_error(
            "credential-store-unavailable",
            "Native credential storage could not be read.",
        )),
    }
}

fn store_bundle(server: &str, bundle: &McpOAuthBundle) -> CommandResult<()> {
    let value = Zeroizing::new(serde_json::to_string(bundle).map_err(|_| {
        oauth_error(
            "credential-store-unavailable",
            "The MCP authorization could not be prepared for secure storage.",
        )
    })?);
    credential_store::write(MCP_OAUTH_SERVICE, server, &value).map_err(|_| {
        oauth_error(
            "credential-store-unavailable",
            "Native credential storage could not be written.",
        )
    })
}

pub fn authorization_status(server: &str) -> McpAuthorization {
    match load_bundle(server) {
        Ok(Some(bundle))
            if !bundle.access_token.trim().is_empty()
                && !bundle.needs_attention
                && (bundle
                    .expires_at
                    .is_none_or(|expires_at| expires_at > chrono::Utc::now().timestamp())
                    || bundle.refresh_token.is_some()) =>
        {
            McpAuthorization {
                state: McpAuthorizationState::Connected,
                available: true,
            }
        }
        Ok(Some(_)) => McpAuthorization {
            state: McpAuthorizationState::NeedsAttention,
            available: true,
        },
        Ok(None) => McpAuthorization {
            state: McpAuthorizationState::NotConnected,
            available: true,
        },
        Err(_) => McpAuthorization {
            state: McpAuthorizationState::NeedsAttention,
            available: false,
        },
    }
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_multicast()
                || ip.is_unspecified())
        }
        IpAddr::V6(ip) => {
            let first = ip.segments()[0];
            !(ip.is_loopback()
                || ip.is_multicast()
                || ip.is_unspecified()
                || first & 0xfe00 == 0xfc00
                || first & 0xffc0 == 0xfe80)
        }
    }
}

fn validated_https_url(raw: &str, label: &str) -> CommandResult<Url> {
    let parsed = Url::parse(raw).map_err(|_| {
        oauth_error(
            "mcp-oauth-unavailable",
            format!("{label} is not a valid URL."),
        )
    })?;
    if parsed.scheme() != "https"
        || parsed.host().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(oauth_error(
            "mcp-oauth-unavailable",
            format!("{label} must be an HTTPS URL without embedded credentials."),
        ));
    }
    match parsed.host() {
        Some(Host::Domain(domain))
            if domain.eq_ignore_ascii_case("localhost")
                || domain.to_ascii_lowercase().ends_with(".localhost") =>
        {
            return Err(oauth_error(
                "mcp-oauth-unavailable",
                format!("{label} cannot target localhost."),
            ));
        }
        Some(Host::Ipv4(ip)) if !is_public_ip(IpAddr::V4(ip)) => {
            return Err(oauth_error(
                "mcp-oauth-unavailable",
                format!("{label} cannot target a private or local address."),
            ));
        }
        Some(Host::Ipv6(ip)) if !is_public_ip(IpAddr::V6(ip)) => {
            return Err(oauth_error(
                "mcp-oauth-unavailable",
                format!("{label} cannot target a private or local address."),
            ));
        }
        _ => {}
    }
    Ok(parsed)
}

fn client() -> CommandResult<Client> {
    Client::builder()
        .timeout(HTTP_TIMEOUT)
        .redirect(Policy::none())
        .user_agent("AI-Integrator/0.1 MCP-OAuth")
        .build()
        .map_err(|_| {
            oauth_error(
                "mcp-oauth-unavailable",
                "The secure MCP sign-in client could not be prepared.",
            )
        })
}

fn bounded_provider_error(body: &str) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let message = parsed
        .as_ref()
        .and_then(|value| {
            value
                .get("error_description")
                .and_then(Value::as_str)
                .or_else(|| value.get("error").and_then(Value::as_str))
                .or_else(|| value.pointer("/error/message").and_then(Value::as_str))
        })
        .unwrap_or("The provider rejected the request.");
    message.chars().take(240).collect()
}

fn response_json(response: reqwest::blocking::Response, label: &str) -> CommandResult<Value> {
    let status = response.status();
    let body = response.text().map_err(|_| {
        oauth_error(
            "mcp-oauth-unavailable",
            format!("{label} returned an unreadable response."),
        )
    })?;
    if !status.is_success() {
        return Err(oauth_error(
            "mcp-oauth-unavailable",
            format!("{label} failed: {}", bounded_provider_error(&body)),
        ));
    }
    serde_json::from_str(&body).map_err(|_| {
        oauth_error(
            "mcp-oauth-unavailable",
            format!("{label} returned invalid OAuth metadata."),
        )
    })
}

fn fetch_json(client: &Client, url: &Url, label: &str) -> CommandResult<Value> {
    let response = client
        .get(url.clone())
        .header(ACCEPT, "application/json")
        .send()
        .map_err(|_| {
            oauth_error(
                "mcp-oauth-unavailable",
                format!("{label} could not be reached."),
            )
        })?;
    response_json(response, label)
}

fn bearer_parameter(header: &str, key: &str) -> Option<String> {
    let lower = header.to_ascii_lowercase();
    let needle = format!("{}=", key.to_ascii_lowercase());
    let start = lower.find(&needle)? + needle.len();
    let rest = header.get(start..)?.trim_start();
    if let Some(quoted) = rest.strip_prefix('"') {
        let end = quoted.find('"')?;
        return Some(quoted[..end].to_owned());
    }
    let end = rest
        .find(|character: char| character == ',' || character.is_ascii_whitespace())
        .unwrap_or(rest.len());
    let value = rest[..end].trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn protected_resource_candidates(resource: &Url) -> Vec<Url> {
    let mut candidates = Vec::new();
    if resource.path() != "/" {
        let mut path_candidate = resource.clone();
        path_candidate.set_query(None);
        path_candidate.set_fragment(None);
        path_candidate.set_path(&format!(
            "/.well-known/oauth-protected-resource{}",
            resource.path()
        ));
        candidates.push(path_candidate);
    }
    let mut root_candidate = resource.clone();
    root_candidate.set_query(None);
    root_candidate.set_fragment(None);
    root_candidate.set_path("/.well-known/oauth-protected-resource");
    if !candidates.contains(&root_candidate) {
        candidates.push(root_candidate);
    }
    candidates
}

fn authorization_metadata_candidates(server: &Url) -> Vec<Url> {
    let issuer_path = server.path().trim_end_matches('/');
    let suffix = if issuer_path.is_empty() || issuer_path == "/" {
        String::new()
    } else {
        issuer_path.to_owned()
    };
    let mut candidates = Vec::new();

    let mut oauth = server.clone();
    oauth.set_query(None);
    oauth.set_fragment(None);
    oauth.set_path(&format!("/.well-known/oauth-authorization-server{suffix}"));
    candidates.push(oauth);

    let mut oidc_at_issuer = server.clone();
    oidc_at_issuer.set_query(None);
    oidc_at_issuer.set_fragment(None);
    oidc_at_issuer.set_path(&format!("{suffix}/.well-known/openid-configuration"));
    if !candidates.contains(&oidc_at_issuer) {
        candidates.push(oidc_at_issuer);
    }

    let mut oidc = server.clone();
    oidc.set_query(None);
    oidc.set_fragment(None);
    oidc.set_path(&format!("/.well-known/openid-configuration{suffix}"));
    if !candidates.contains(&oidc) {
        candidates.push(oidc);
    }

    if !suffix.is_empty() {
        let mut root = server.clone();
        root.set_query(None);
        root.set_fragment(None);
        root.set_path("/.well-known/oauth-authorization-server");
        if !candidates.contains(&root) {
            candidates.push(root);
        }
    }
    candidates
}

fn discover_oauth(client: &Client, server_url: &Url) -> CommandResult<OAuthDiscovery> {
    let mut metadata_url = None;
    let mut challenged_scope = None;
    if let Ok(response) = client
        .get(server_url.clone())
        .header("MCP-Protocol-Version", MCP_PROTOCOL_VERSION)
        .send()
    {
        for header in response.headers().get_all(WWW_AUTHENTICATE) {
            let Ok(header) = header.to_str() else {
                continue;
            };
            metadata_url = metadata_url.or_else(|| bearer_parameter(header, "resource_metadata"));
            challenged_scope = challenged_scope.or_else(|| bearer_parameter(header, "scope"));
        }
    }

    let resource_candidates = if let Some(metadata_url) = metadata_url {
        vec![validated_https_url(
            &metadata_url,
            "The MCP protected-resource metadata URL",
        )?]
    } else {
        protected_resource_candidates(server_url)
    };
    let mut protected = None;
    for candidate in resource_candidates {
        let Ok(value) = fetch_json(client, &candidate, "MCP authorization discovery") else {
            continue;
        };
        let Ok(parsed) = serde_json::from_value::<ProtectedResourceMetadata>(value) else {
            continue;
        };
        protected = Some(parsed);
        break;
    }
    let protected = protected.ok_or_else(|| {
        oauth_error(
            "mcp-oauth-unavailable",
            "This server did not expose MCP OAuth discovery metadata.",
        )
    })?;
    let resource = validated_https_url(&protected.resource, "The MCP OAuth resource")?;
    let authorization_server = protected.authorization_servers.first().ok_or_else(|| {
        oauth_error(
            "mcp-oauth-unavailable",
            "This server did not name an OAuth authorization server.",
        )
    })?;
    let authorization_server =
        validated_https_url(authorization_server, "The MCP authorization server")?;

    let mut metadata = None;
    for candidate in authorization_metadata_candidates(&authorization_server) {
        let Ok(value) = fetch_json(client, &candidate, "OAuth server discovery") else {
            continue;
        };
        let Ok(parsed) = serde_json::from_value::<AuthorizationServerMetadata>(value) else {
            continue;
        };
        metadata = Some(parsed);
        break;
    }
    let metadata = metadata.ok_or_else(|| {
        oauth_error(
            "mcp-oauth-unavailable",
            "The MCP authorization server did not expose supported OAuth metadata.",
        )
    })?;
    if !metadata
        .code_challenge_methods_supported
        .iter()
        .any(|method| method == "S256")
    {
        return Err(oauth_error(
            "mcp-oauth-unavailable",
            "This provider does not advertise the required PKCE S256 protection.",
        ));
    }
    validated_https_url(
        &metadata.authorization_endpoint,
        "The OAuth authorization endpoint",
    )?;
    validated_https_url(&metadata.token_endpoint, "The OAuth token endpoint")?;

    let scopes = challenged_scope
        .map(|scope| {
            scope
                .split_ascii_whitespace()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .filter(|scopes| !scopes.is_empty())
        .or_else(|| (!protected.scopes_supported.is_empty()).then_some(protected.scopes_supported))
        .unwrap_or_else(|| metadata.scopes_supported.clone());
    Ok(OAuthDiscovery {
        resource,
        scopes,
        metadata,
    })
}

fn random_urlsafe(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    rand::rng().fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

fn form_body(fields: &[(String, String)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in fields {
        serializer.append_pair(key, value);
    }
    serializer.finish()
}

fn post_form(
    client: &Client,
    url: &Url,
    fields: &[(String, String)],
    client_id: &str,
    client_secret: Option<&str>,
    auth_method: &str,
) -> RequestBuilder {
    let mut request = client
        .post(url.clone())
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(ACCEPT, "application/json")
        .body(form_body(fields));
    if auth_method == "client_secret_basic" {
        request = request.basic_auth(client_id, client_secret);
    }
    request
}

fn register_client(
    client: &Client,
    metadata: &AuthorizationServerMetadata,
    redirect_uri: &str,
) -> CommandResult<(RegistrationResponse, String)> {
    let registration_endpoint = metadata.registration_endpoint.as_deref().ok_or_else(|| {
        oauth_error(
            "mcp-oauth-registration-required",
            "This provider requires a pre-registered OAuth client. Use its vendor-owned MCP sign-in flow for now.",
        )
    })?;
    let registration_endpoint =
        validated_https_url(registration_endpoint, "The OAuth registration endpoint")?;
    let auth_method = if metadata
        .token_endpoint_auth_methods_supported
        .iter()
        .any(|method| method == "none")
    {
        "none"
    } else if metadata
        .token_endpoint_auth_methods_supported
        .iter()
        .any(|method| method == "client_secret_basic")
    {
        "client_secret_basic"
    } else if metadata
        .token_endpoint_auth_methods_supported
        .iter()
        .any(|method| method == "client_secret_post")
    {
        "client_secret_post"
    } else {
        return Err(oauth_error(
            "mcp-oauth-unavailable",
            "This provider does not advertise a supported OAuth client authentication method.",
        ));
    };
    let body = serde_json::json!({
        "client_name": "AI Integrator",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": auth_method,
    });
    let response = client
        .post(registration_endpoint)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "application/json")
        .body(serde_json::to_vec(&body).expect("static OAuth registration serializes"))
        .send()
        .map_err(|_| {
            oauth_error(
                "mcp-oauth-unavailable",
                "The provider's OAuth registration endpoint could not be reached.",
            )
        })?;
    let registration = serde_json::from_value::<RegistrationResponse>(response_json(
        response,
        "OAuth registration",
    )?)
    .map_err(|_| {
        oauth_error(
            "mcp-oauth-unavailable",
            "The provider returned an invalid OAuth client registration.",
        )
    })?;
    if registration.client_id.trim().is_empty() {
        return Err(oauth_error(
            "mcp-oauth-unavailable",
            "The provider did not issue an OAuth client identifier.",
        ));
    }
    let effective_method = registration
        .token_endpoint_auth_method
        .clone()
        .unwrap_or_else(|| auth_method.to_owned());
    if effective_method != "none" && registration.client_secret.is_none() {
        return Err(oauth_error(
            "mcp-oauth-unavailable",
            "The provider did not issue the client secret required by its token endpoint.",
        ));
    }
    Ok((registration, effective_method))
}

fn callback_response(stream: &mut std::net::TcpStream, success: bool) {
    let (title, message) = if success {
        (
            "AI Integrator connected",
            "Authorization is complete. You can close this tab and return to AI Integrator.",
        )
    } else {
        (
            "AI Integrator could not connect",
            "The authorization response was not valid. Return to AI Integrator and try again.",
        )
    };
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{title}</title><body style=\"font-family:system-ui;margin:48px;max-width:560px\"><h1>{title}</h1><p>{message}</p></body>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn callback_code(listener: &TcpListener, expected_state: &str) -> CommandResult<String> {
    listener.set_nonblocking(true).map_err(|_| {
        oauth_error(
            "mcp-oauth-unavailable",
            "The local OAuth callback could not be prepared.",
        )
    })?;
    let deadline = Instant::now() + CALLBACK_TIMEOUT;
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, address)) => {
                if !address.ip().is_loopback() {
                    continue;
                }
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut request = Vec::new();
                let mut chunk = [0_u8; 2048];
                while request.len() < MAX_CALLBACK_BYTES {
                    let count = match stream.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(count) => count,
                        Err(error)
                            if matches!(
                                error.kind(),
                                ErrorKind::WouldBlock | ErrorKind::TimedOut
                            ) =>
                        {
                            break;
                        }
                        Err(_) => break,
                    };
                    request.extend_from_slice(&chunk[..count]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                let first_line = String::from_utf8_lossy(&request)
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .to_owned();
                let Some(target) = first_line
                    .strip_prefix("GET ")
                    .and_then(|line| line.split_once(' '))
                    .map(|(target, _)| target)
                else {
                    callback_response(&mut stream, false);
                    continue;
                };
                let Ok(callback) = Url::parse(&format!("http://127.0.0.1{target}")) else {
                    callback_response(&mut stream, false);
                    continue;
                };
                if callback.path() != CALLBACK_PATH {
                    callback_response(&mut stream, false);
                    continue;
                }
                let params = callback
                    .query_pairs()
                    .collect::<std::collections::HashMap<_, _>>();
                if let Some(error) = params.get("error") {
                    callback_response(&mut stream, false);
                    return Err(oauth_error(
                        "mcp-oauth-cancelled",
                        format!("The provider did not authorize this connection: {error}."),
                    ));
                }
                let state_matches = params
                    .get("state")
                    .is_some_and(|state| state.as_ref() == expected_state);
                let code = params.get("code").map(|code| code.to_string());
                if !state_matches || code.as_deref().is_none_or(str::is_empty) {
                    callback_response(&mut stream, false);
                    return Err(oauth_error(
                        "mcp-oauth-invalid-callback",
                        "The OAuth callback did not match the sign-in request.",
                    ));
                }
                callback_response(&mut stream, true);
                return Ok(code.expect("checked above"));
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(75));
            }
            Err(_) => {
                return Err(oauth_error(
                    "mcp-oauth-unavailable",
                    "The local OAuth callback stopped unexpectedly.",
                ));
            }
        }
    }
    Err(oauth_error(
        "mcp-oauth-timeout",
        "MCP sign-in timed out. Nothing was stored.",
    ))
}

fn token_fields(
    value: Value,
) -> CommandResult<(String, Option<String>, Option<i64>, Option<String>)> {
    let access_token = value
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| {
            oauth_error(
                "mcp-oauth-unavailable",
                "The provider did not return an access token.",
            )
        })?
        .to_owned();
    let token_type = value
        .get("token_type")
        .and_then(Value::as_str)
        .unwrap_or("Bearer");
    if !token_type.eq_ignore_ascii_case("bearer") {
        return Err(oauth_error(
            "mcp-oauth-unavailable",
            "The provider returned an unsupported OAuth token type.",
        ));
    }
    let refresh_token = value
        .get("refresh_token")
        .and_then(Value::as_str)
        .filter(|token| !token.trim().is_empty())
        .map(str::to_owned);
    let expires_in = value
        .get("expires_in")
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
        })
        .filter(|seconds| *seconds > 0);
    let expires_at = expires_in.map(|seconds| chrono::Utc::now().timestamp() + seconds);
    let scope = value
        .get("scope")
        .and_then(Value::as_str)
        .filter(|scope| !scope.trim().is_empty())
        .map(str::to_owned);
    Ok((access_token, refresh_token, expires_at, scope))
}

fn exchange_code(
    client: &Client,
    discovery: &OAuthDiscovery,
    registration: &RegistrationResponse,
    auth_method: &str,
    redirect_uri: &str,
    code: &str,
    verifier: &str,
) -> CommandResult<McpOAuthBundle> {
    let token_endpoint = validated_https_url(
        &discovery.metadata.token_endpoint,
        "The OAuth token endpoint",
    )?;
    let mut fields = vec![
        ("grant_type".into(), "authorization_code".into()),
        ("code".into(), code.into()),
        ("redirect_uri".into(), redirect_uri.into()),
        ("client_id".into(), registration.client_id.clone()),
        ("code_verifier".into(), verifier.into()),
        ("resource".into(), discovery.resource.to_string()),
    ];
    if auth_method == "client_secret_post" {
        fields.push((
            "client_secret".into(),
            registration.client_secret.clone().unwrap_or_default(),
        ));
    }
    let response = post_form(
        client,
        &token_endpoint,
        &fields,
        &registration.client_id,
        registration.client_secret.as_deref(),
        auth_method,
    )
    .send()
    .map_err(|_| {
        oauth_error(
            "mcp-oauth-unavailable",
            "The provider's token endpoint could not be reached.",
        )
    })?;
    let token = response_json(response, "OAuth token exchange")?;
    let (access_token, refresh_token, expires_at, returned_scope) = token_fields(token)?;
    Ok(McpOAuthBundle {
        client_id: registration.client_id.clone(),
        client_secret: registration.client_secret.clone(),
        token_endpoint_auth_method: auth_method.to_owned(),
        token_endpoint: token_endpoint.to_string(),
        revocation_endpoint: discovery.metadata.revocation_endpoint.clone(),
        resource: discovery.resource.to_string(),
        access_token,
        refresh_token,
        expires_at,
        scope: returned_scope
            .or_else(|| (!discovery.scopes.is_empty()).then(|| discovery.scopes.join(" "))),
        needs_attention: false,
    })
}

pub fn connect(server: &str, raw_url: &str) -> CommandResult<()> {
    let server_url = validated_https_url(raw_url, "The MCP server URL")?;
    let client = client()?;
    let discovery = discover_oauth(&client, &server_url)?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|_| {
        oauth_error(
            "mcp-oauth-unavailable",
            "AI Integrator could not reserve a local OAuth callback.",
        )
    })?;
    let redirect_uri = format!(
        "http://127.0.0.1:{}{CALLBACK_PATH}",
        listener
            .local_addr()
            .map_err(|_| {
                oauth_error(
                    "mcp-oauth-unavailable",
                    "AI Integrator could not read the local OAuth callback address.",
                )
            })?
            .port()
    );
    let (registration, auth_method) = register_client(&client, &discovery.metadata, &redirect_uri)?;
    let state = random_urlsafe(32);
    let verifier = random_urlsafe(48);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut authorization_url = validated_https_url(
        &discovery.metadata.authorization_endpoint,
        "The OAuth authorization endpoint",
    )?;
    {
        let mut query = authorization_url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", &registration.client_id)
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("resource", discovery.resource.as_str());
        if !discovery.scopes.is_empty() {
            query.append_pair("scope", &discovery.scopes.join(" "));
        }
    }
    open_external_url(authorization_url.to_string())?;
    let code = callback_code(&listener, &state)?;
    let bundle = exchange_code(
        &client,
        &discovery,
        &registration,
        &auth_method,
        &redirect_uri,
        &code,
        &verifier,
    )?;
    store_bundle(server, &bundle)
}

fn refresh_bundle(client: &Client, bundle: &McpOAuthBundle) -> CommandResult<McpOAuthBundle> {
    let refresh_token = bundle.refresh_token.as_deref().ok_or_else(|| {
        oauth_error(
            "mcp-oauth-unavailable",
            "This MCP connection needs to be signed in again.",
        )
    })?;
    let token_endpoint = validated_https_url(&bundle.token_endpoint, "The OAuth token endpoint")?;
    let mut fields = vec![
        ("grant_type".into(), "refresh_token".into()),
        ("refresh_token".into(), refresh_token.into()),
        ("client_id".into(), bundle.client_id.clone()),
        ("resource".into(), bundle.resource.clone()),
    ];
    if let Some(scope) = bundle
        .scope
        .as_ref()
        .filter(|scope| !scope.trim().is_empty())
    {
        fields.push(("scope".into(), scope.clone()));
    }
    if bundle.token_endpoint_auth_method == "client_secret_post" {
        fields.push((
            "client_secret".into(),
            bundle.client_secret.clone().unwrap_or_default(),
        ));
    }
    let response = post_form(
        client,
        &token_endpoint,
        &fields,
        &bundle.client_id,
        bundle.client_secret.as_deref(),
        &bundle.token_endpoint_auth_method,
    )
    .send()
    .map_err(|_| {
        oauth_error(
            "mcp-oauth-unavailable",
            "The MCP authorization could not be refreshed.",
        )
    })?;
    let token = response_json(response, "OAuth token refresh")?;
    let (access_token, refresh_token, expires_at, scope) = token_fields(token)?;
    Ok(McpOAuthBundle {
        access_token,
        refresh_token: refresh_token.or_else(|| bundle.refresh_token.clone()),
        expires_at,
        scope: scope.or_else(|| bundle.scope.clone()),
        needs_attention: false,
        ..bundle.clone()
    })
}

pub fn authorization_header(server: &str) -> Option<String> {
    let mut bundle = load_bundle(server).ok().flatten()?;
    if bundle.needs_attention {
        return None;
    }
    if bundle.expires_at.is_some_and(|expires_at| {
        expires_at <= chrono::Utc::now().timestamp() + REFRESH_MARGIN_SECONDS
    }) {
        match client().and_then(|client| refresh_bundle(&client, &bundle)) {
            Ok(refreshed) => {
                bundle = refreshed;
                if store_bundle(server, &bundle).is_err() {
                    return None;
                }
            }
            Err(_) => {
                bundle.needs_attention = true;
                let _ = store_bundle(server, &bundle);
                return None;
            }
        }
    }
    (!bundle.access_token.trim().is_empty()).then(|| format!("Bearer {}", bundle.access_token))
}

fn revoke(client: &Client, bundle: &McpOAuthBundle) {
    let Some(endpoint) = bundle
        .revocation_endpoint
        .as_deref()
        .and_then(|endpoint| validated_https_url(endpoint, "The OAuth revocation endpoint").ok())
    else {
        return;
    };
    let token = bundle
        .refresh_token
        .as_deref()
        .unwrap_or(&bundle.access_token);
    let mut fields = vec![
        ("token".into(), token.into()),
        ("client_id".into(), bundle.client_id.clone()),
    ];
    if bundle.refresh_token.is_some() {
        fields.push(("token_type_hint".into(), "refresh_token".into()));
    }
    if bundle.token_endpoint_auth_method == "client_secret_post" {
        fields.push((
            "client_secret".into(),
            bundle.client_secret.clone().unwrap_or_default(),
        ));
    }
    let _ = post_form(
        client,
        &endpoint,
        &fields,
        &bundle.client_id,
        bundle.client_secret.as_deref(),
        &bundle.token_endpoint_auth_method,
    )
    .send();
}

pub fn disconnect(server: &str) -> CommandResult<()> {
    let bundle = load_bundle(server)?;
    credential_store::delete(MCP_OAUTH_SERVICE, server).map_err(|_| {
        oauth_error(
            "credential-store-unavailable",
            "Native credential storage could not be updated.",
        )
    })?;
    if let Some(bundle) = bundle
        && let Ok(client) = client()
    {
        revoke(&client, &bundle);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_parameters_support_quoted_and_unquoted_values() {
        assert_eq!(
            bearer_parameter(
                r#"Bearer realm="OAuth", resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp", scope="read write""#,
                "resource_metadata",
            )
            .as_deref(),
            Some("https://mcp.example/.well-known/oauth-protected-resource/mcp")
        );
        assert_eq!(
            bearer_parameter(
                "Bearer resource_metadata=https://mcp.example/.well-known/oauth-protected-resource",
                "resource_metadata",
            )
            .as_deref(),
            Some("https://mcp.example/.well-known/oauth-protected-resource")
        );
    }

    #[test]
    fn metadata_candidates_follow_rfc_path_and_root_forms() {
        let server = Url::parse("https://mcp.example.com/team/mcp").expect("url");
        let protected = protected_resource_candidates(&server)
            .into_iter()
            .map(|url| url.to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            protected,
            vec![
                "https://mcp.example.com/.well-known/oauth-protected-resource/team/mcp",
                "https://mcp.example.com/.well-known/oauth-protected-resource",
            ]
        );

        let issuer = Url::parse("https://auth.example.com/tenant").expect("url");
        let authorization = authorization_metadata_candidates(&issuer)
            .into_iter()
            .map(|url| url.to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            authorization.first().map(String::as_str),
            Some("https://auth.example.com/.well-known/oauth-authorization-server/tenant")
        );
        assert!(authorization.contains(
            &"https://auth.example.com/tenant/.well-known/openid-configuration".to_owned()
        ));
    }

    #[test]
    fn oauth_endpoints_fail_closed_for_local_or_insecure_targets() {
        assert!(validated_https_url("http://mcp.example.com", "server").is_err());
        assert!(validated_https_url("https://localhost/mcp", "server").is_err());
        assert!(validated_https_url("https://127.0.0.1/mcp", "server").is_err());
        assert!(validated_https_url("https://mcp.example.com/mcp", "server").is_ok());
    }
}
