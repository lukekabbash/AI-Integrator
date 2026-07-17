//! Narrow, read-only data access for bundled skills.
//!
//! Agent runtimes call the `skill_data_request` tool on Integrator's local
//! MCP server. The thin MCP process forwards only public request parameters
//! to the running desktop process; this module retrieves the named secret
//! from the OS credential store, injects it into one fixed official endpoint,
//! and performs the HTTPS request in-process.

use std::time::Duration;

use integrator_core::{IntegratorError, Result};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tauri::AppHandle;
use url::Url;

use crate::integrator_skills::{enabled_skill_named, skill_credential_secret};
use crate::state::AppState;

const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ERROR_CHARS: usize = 4_096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SkillApi {
    Fred,
    Bls,
    Census,
    Eia,
    AlphaVantage,
}

impl SkillApi {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "fred" => Some(Self::Fred),
            "bls" => Some(Self::Bls),
            "census" => Some(Self::Census),
            "eia" => Some(Self::Eia),
            "alpha-vantage" => Some(Self::AlphaVantage),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Fred => "fred",
            Self::Bls => "bls",
            Self::Census => "census",
            Self::Eia => "eia",
            Self::AlphaVantage => "alpha-vantage",
        }
    }

    fn skill_name(self) -> &'static str {
        match self {
            Self::Fred => "gov-data:fred",
            Self::Bls => "gov-data:bls",
            Self::Census => "gov-data:census",
            Self::Eia => "gov-data:eia",
            Self::AlphaVantage => "market-data:alpha-vantage",
        }
    }

    fn specification(self) -> ProviderSpecification {
        match self {
            Self::Fred => ProviderSpecification {
                base: "https://api.stlouisfed.org",
                path_prefix: "/fred/",
                fixed_path: None,
                credential_id: Some("fred-api-key"),
                credential_required: true,
                secret_parameter: Some("api_key"),
                method: RequestMethod::Get,
            },
            Self::Bls => ProviderSpecification {
                base: "https://api.bls.gov",
                path_prefix: "/publicAPI/v2/timeseries/data/",
                fixed_path: Some("/publicAPI/v2/timeseries/data/"),
                credential_id: Some("bls-api-key"),
                credential_required: false,
                secret_parameter: None,
                method: RequestMethod::Post,
            },
            Self::Census => ProviderSpecification {
                base: "https://api.census.gov",
                path_prefix: "/data/",
                fixed_path: None,
                credential_id: Some("census-api-key"),
                credential_required: true,
                secret_parameter: Some("key"),
                method: RequestMethod::Get,
            },
            Self::Eia => ProviderSpecification {
                base: "https://api.eia.gov",
                path_prefix: "/v2/",
                fixed_path: None,
                credential_id: Some("eia-api-key"),
                credential_required: true,
                secret_parameter: Some("api_key"),
                method: RequestMethod::Get,
            },
            Self::AlphaVantage => ProviderSpecification {
                base: "https://www.alphavantage.co",
                path_prefix: "/query",
                fixed_path: Some("/query"),
                credential_id: Some("alpha-vantage-api-key"),
                credential_required: true,
                secret_parameter: Some("apikey"),
                method: RequestMethod::Get,
            },
        }
    }
}

#[derive(Clone, Copy)]
enum RequestMethod {
    Get,
    Post,
}

#[derive(Clone, Copy)]
struct ProviderSpecification {
    base: &'static str,
    path_prefix: &'static str,
    fixed_path: Option<&'static str>,
    credential_id: Option<&'static str>,
    credential_required: bool,
    secret_parameter: Option<&'static str>,
    method: RequestMethod,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillDataRequest {
    provider: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    query: Map<String, Value>,
    #[serde(default)]
    body: Map<String, Value>,
}

struct PreparedRequest {
    api: SkillApi,
    url: Url,
    method: RequestMethod,
    body: Option<String>,
}

pub async fn execute(app: &AppHandle, state: &AppState, params: &Value) -> Result<Value> {
    if serde_json::to_vec(params)?.len() > MAX_REQUEST_BYTES {
        return Err(IntegratorError::InvalidInput(
            "skill data request exceeds the 256 KiB limit".into(),
        ));
    }
    let request: SkillDataRequest = serde_json::from_value(params.clone())
        .map_err(|_| IntegratorError::InvalidInput("invalid skill data request".into()))?;
    let api = SkillApi::parse(request.provider.trim()).ok_or_else(|| {
        IntegratorError::InvalidInput(
            "provider must be fred, bls, census, eia, or alpha-vantage".into(),
        )
    })?;
    let enabled = enabled_skill_named(app, &state.store, api.skill_name())
        .is_some_and(|entry| entry.source == "first-party");
    if !enabled {
        return Err(IntegratorError::Unauthorized(format!(
            "enable {} in AI Integrator Settings before using this data tool",
            api.skill_name()
        )));
    }

    let specification = api.specification();
    let secret = match specification.credential_id {
        Some(id) => skill_credential_secret(state, id, specification.credential_required)?,
        None => None,
    };
    let secret_ref = secret.as_ref().map(|secret| secret.as_str());
    let prepared = prepare_request(request, api, secret_ref)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .https_only(true)
        .user_agent(concat!("AI-Integrator/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| {
            IntegratorError::Unavailable("secure data client could not be created".into())
        })?;
    let request_url = prepared.url.clone();
    let mut builder = match prepared.method {
        RequestMethod::Get => client.get(prepared.url),
        RequestMethod::Post => client
            .post(prepared.url)
            .header(reqwest::header::CONTENT_TYPE, "application/json"),
    };
    if let Some(body) = prepared.body {
        builder = builder.body(body);
    }
    let mut response = builder.send().await.map_err(|_| {
        IntegratorError::Unavailable(format!(
            "{} could not be reached through the secure data tool",
            prepared.api.name()
        ))
    })?;
    let status = response.status();
    let redirect_path = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| safe_redirect_path(&request_url, value));
    let mut response_bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        IntegratorError::Unavailable(format!(
            "{} returned an unreadable response",
            prepared.api.name()
        ))
    })? {
        if response_bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(IntegratorError::Unavailable(
                "the data provider response exceeded the 4 MiB safety limit".into(),
            ));
        }
        response_bytes.extend_from_slice(&chunk);
    }
    let response_text = redact_secret(
        String::from_utf8_lossy(&response_bytes).into_owned(),
        secret_ref,
    );
    if !status.is_success() {
        if let Some(message) = redirect_error(prepared.api, redirect_path.as_deref()) {
            return Err(IntegratorError::Unavailable(message));
        }
        let detail: String = response_text.chars().take(MAX_ERROR_CHARS).collect();
        return Err(IntegratorError::Unavailable(if detail.trim().is_empty() {
            format!(
                "{} rejected the request with HTTP {}",
                prepared.api.name(),
                status.as_u16()
            )
        } else {
            format!(
                "{} rejected the request with HTTP {}: {}",
                prepared.api.name(),
                status.as_u16(),
                detail.trim()
            )
        }));
    }
    let data =
        serde_json::from_str(&response_text).unwrap_or_else(|_| Value::String(response_text));
    Ok(json!({
        "provider": prepared.api.name(),
        "status": status.as_u16(),
        "data": data,
    }))
}

fn safe_redirect_path(request_url: &Url, location: &str) -> Option<String> {
    let redirect = request_url.join(location).ok()?;
    (redirect.scheme() == "https"
        && redirect.host_str() == request_url.host_str()
        && redirect.port_or_known_default() == request_url.port_or_known_default())
    .then(|| redirect.path().to_owned())
}

fn redirect_error(api: SkillApi, path: Option<&str>) -> Option<String> {
    match (api, path) {
        (SkillApi::Census, Some("/data/missing_key.html")) => {
            Some("census rejected the request because no API key was accepted".into())
        }
        (SkillApi::Census, Some("/data/invalid_key.html")) => {
            Some("census rejected the saved API key as invalid".into())
        }
        (_, Some(path)) => Some(format!("{} redirected the request to {path}", api.name())),
        (_, None) => None,
    }
}

fn prepare_request(
    request: SkillDataRequest,
    api: SkillApi,
    secret: Option<&str>,
) -> Result<PreparedRequest> {
    let specification = api.specification();
    let path = match specification.fixed_path {
        Some(path) => {
            if request.path.as_deref().is_some_and(|value| value != path) {
                return Err(IntegratorError::InvalidInput(
                    "this provider does not accept a custom path".into(),
                ));
            }
            path.to_owned()
        }
        None => request.path.ok_or_else(|| {
            IntegratorError::InvalidInput("this provider requires an official API path".into())
        })?,
    };
    if path.len() > 512
        || !path.starts_with(specification.path_prefix)
        || path.contains("..")
        || path.contains("://")
        || path.chars().any(char::is_control)
    {
        return Err(IntegratorError::InvalidInput(
            "the requested provider path is not allowed".into(),
        ));
    }
    if request.query.len() > 128 || request.body.len() > 128 {
        return Err(IntegratorError::InvalidInput(
            "skill data requests may contain at most 128 query or body fields".into(),
        ));
    }
    if !matches!(specification.method, RequestMethod::Post) && !request.body.is_empty() {
        return Err(IntegratorError::InvalidInput(
            "this provider does not accept a request body".into(),
        ));
    }
    if matches!(specification.method, RequestMethod::Post) && !request.query.is_empty() {
        return Err(IntegratorError::InvalidInput(
            "this provider accepts request data in the body, not the query".into(),
        ));
    }

    let mut url = Url::parse(specification.base)
        .map_err(|_| IntegratorError::Unavailable("provider URL is invalid".into()))?;
    url.set_path(&path);
    {
        let mut pairs = url.query_pairs_mut();
        append_query_pairs(&mut pairs, &request.query, specification.secret_parameter)?;
        if let (Some(parameter), Some(secret)) = (specification.secret_parameter, secret) {
            pairs.append_pair(parameter, secret);
        }
    }
    let body = if matches!(specification.method, RequestMethod::Post) {
        if request.body.is_empty() {
            return Err(IntegratorError::InvalidInput(
                "BLS requests require a JSON object in body".into(),
            ));
        }
        if request
            .body
            .keys()
            .any(|key| key.eq_ignore_ascii_case("registrationkey"))
        {
            return Err(IntegratorError::InvalidInput(
                "registrationkey is reserved for AI Integrator".into(),
            ));
        }
        let mut body = request.body;
        if let Some(secret) = secret {
            body.insert("registrationkey".into(), Value::String(secret.into()));
        }
        Some(serde_json::to_string(&body)?)
    } else {
        None
    };
    Ok(PreparedRequest {
        api,
        url,
        method: specification.method,
        body,
    })
}

fn append_query_pairs(
    pairs: &mut url::form_urlencoded::Serializer<'_, url::UrlQuery<'_>>,
    query: &Map<String, Value>,
    secret_parameter: Option<&str>,
) -> Result<()> {
    for (key, value) in query {
        if key.is_empty()
            || key.len() > 128
            || key.chars().any(char::is_control)
            || secret_parameter.is_some_and(|parameter| key.eq_ignore_ascii_case(parameter))
        {
            return Err(IntegratorError::InvalidInput(
                "the request contains a reserved query parameter".into(),
            ));
        }
        match value {
            Value::String(value) if value.len() <= 16 * 1024 => {
                pairs.append_pair(key, value);
            }
            Value::Number(value) => {
                pairs.append_pair(key, &value.to_string());
            }
            Value::Bool(value) => {
                pairs.append_pair(key, if *value { "true" } else { "false" });
            }
            Value::Array(values) if values.len() <= 128 => {
                for value in values {
                    let value = value
                        .as_str()
                        .filter(|value| value.len() <= 16 * 1024)
                        .ok_or_else(|| {
                            IntegratorError::InvalidInput(
                                "query arrays may contain only bounded strings".into(),
                            )
                        })?;
                    pairs.append_pair(key, value);
                }
            }
            _ => {
                return Err(IntegratorError::InvalidInput(
                    "query values must be bounded strings, numbers, booleans, or string arrays"
                        .into(),
                ));
            }
        }
    }
    Ok(())
}

fn redact_secret(mut value: String, secret: Option<&str>) -> String {
    if let Some(secret) = secret.filter(|secret| !secret.is_empty()) {
        value = value.replace(secret, "[redacted]");
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(provider: &str) -> SkillDataRequest {
        SkillDataRequest {
            provider: provider.into(),
            path: None,
            query: Map::new(),
            body: Map::new(),
        }
    }

    #[test]
    fn alpha_vantage_authority_tracks_the_provider_specific_skill() {
        assert_eq!(
            SkillApi::AlphaVantage.skill_name(),
            "market-data:alpha-vantage"
        );
    }

    #[test]
    fn rejects_secret_query_overrides_and_external_paths() {
        let mut external = request("fred");
        external.path = Some("https://example.com/steal".into());
        assert!(prepare_request(external, SkillApi::Fred, Some("secret")).is_err());

        let mut override_key = request("fred");
        override_key.path = Some("/fred/series".into());
        override_key
            .query
            .insert("api_key".into(), Value::String("attacker".into()));
        assert!(prepare_request(override_key, SkillApi::Fred, Some("secret")).is_err());
    }

    #[test]
    fn prepares_census_and_bls_with_native_injection() {
        let mut census = request("census");
        census.path = Some("/data/2023/acs/acs5".into());
        census
            .query
            .insert("for".into(), Value::String("state:*".into()));
        let prepared = prepare_request(census, SkillApi::Census, Some("native-secret"))
            .expect("credentialed Census request");
        assert_eq!(
            prepared.url.as_str(),
            "https://api.census.gov/data/2023/acs/acs5?for=state%3A*&key=native-secret"
        );

        let mut bls = request("bls");
        bls.body
            .insert("seriesid".into(), json!(["LNS14000000", "CUUR0000SA0"]));
        let prepared =
            prepare_request(bls, SkillApi::Bls, Some("native-secret")).expect("BLS request");
        let body = prepared.body.expect("BLS body");
        assert!(body.contains("\"registrationkey\":\"native-secret\""));
    }

    #[test]
    fn fixed_provider_paths_and_secret_fields_are_host_owned() {
        let mut alpha = request("alpha-vantage");
        alpha.path = Some("/other".into());
        assert!(prepare_request(alpha, SkillApi::AlphaVantage, Some("secret")).is_err());

        let mut bls = request("bls");
        bls.body
            .insert("RegistrationKey".into(), Value::String("attacker".into()));
        assert!(prepare_request(bls, SkillApi::Bls, Some("secret")).is_err());
    }

    #[test]
    fn response_redaction_never_returns_the_native_secret() {
        assert_eq!(
            redact_secret("request used abc123".into(), Some("abc123")),
            "request used [redacted]"
        );
    }

    #[test]
    fn redirect_diagnostics_are_same_origin_and_provider_specific() {
        let request = Url::parse("https://api.census.gov/data/2023/acs/acs5").expect("URL");
        assert_eq!(
            safe_redirect_path(&request, "https://api.census.gov/data/invalid_key.html"),
            Some("/data/invalid_key.html".into())
        );
        assert_eq!(
            redirect_error(SkillApi::Census, Some("/data/invalid_key.html")),
            Some("census rejected the saved API key as invalid".into())
        );
        assert!(safe_redirect_path(&request, "https://example.com/capture?key=secret").is_none());
    }
}
