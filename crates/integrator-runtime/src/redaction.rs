use serde_json::{Map, Value};

const AUDIT_LIMIT: usize = 256 * 1024;
pub(crate) const TEXT_LIMIT: usize = 16 * 1024;

pub fn redact_and_bound(value: &str, limit: usize) -> (String, bool) {
    bound_and_redact(value, limit)
}

pub(crate) fn bound_and_redact(value: &str, limit: usize) -> (String, bool) {
    let redacted = redact_text(value);
    truncate_utf8(&redacted, limit)
}

// Provider tool output may already have been visible to the model. Do not hide
// legitimate evidence from the user based on entropy or length guesses; redact
// only explicit credential syntax that must not become durable transcript data.
pub(crate) fn redact_text(value: &str) -> String {
    if let Some(redacted) = redact_json_document(value) {
        return redacted;
    }
    let mut private_key = false;
    let mut output = String::with_capacity(value.len());
    for segment in value.split_inclusive('\n') {
        let (line, ending) = if let Some(line) = segment.strip_suffix("\r\n") {
            (line, "\r\n")
        } else if let Some(line) = segment.strip_suffix('\n') {
            (line, "\n")
        } else {
            (segment, "")
        };
        let upper = line.to_ascii_uppercase();
        if upper.contains("-----BEGIN") && upper.contains("PRIVATE KEY-----") {
            private_key = true;
            output.push_str("[redacted-private-key]");
        } else if private_key {
            if upper.contains("-----END") && upper.contains("PRIVATE KEY-----") {
                private_key = false;
            }
            output.push_str("[redacted-private-key]");
        } else if let Some(header) = redact_sensitive_header(line) {
            output.push_str(&header);
        } else {
            output.push_str(&redact_line(line));
        }
        output.push_str(ending);
    }
    output
}

fn redact_sensitive_header(line: &str) -> Option<String> {
    let value = line.trim_start();
    let (name, _) = value.split_once(':')?;
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization" | "cookie" | "set-cookie"
    )
    .then(|| {
        let indentation = &line[..line.len() - value.len()];
        format!("{indentation}{name}: [redacted]")
    })
}

fn redact_line(line: &str) -> String {
    let mut output = String::with_capacity(line.len());
    let mut cursor = 0;
    let mut redact_next = false;
    while cursor < line.len() {
        let token_start = line[cursor..]
            .char_indices()
            .find(|(_, character)| !character.is_whitespace())
            .map(|(index, _)| cursor + index)
            .unwrap_or(line.len());
        output.push_str(&line[cursor..token_start]);
        if token_start == line.len() {
            break;
        }
        let token_end = line[token_start..]
            .char_indices()
            .find(|(_, character)| character.is_whitespace())
            .map(|(index, _)| token_start + index)
            .unwrap_or(line.len());
        let token = &line[token_start..token_end];
        let normalized = token.trim_matches(|character: char| {
            matches!(
                character,
                '"' | '\'' | '`' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | ',' | ';'
            )
        });
        if redact_next || looks_like_known_secret(normalized) {
            output.push_str("[redacted]");
            redact_next = false;
        } else if normalized.eq_ignore_ascii_case("bearer") {
            output.push_str(token);
            redact_next = true;
        } else if let Some(redacted) = redact_sensitive_assignment(token) {
            output.push_str(&redacted);
        } else if token.contains("://") && token.contains('@') {
            output.push_str(&redact_credential_url(token));
        } else {
            output.push_str(token);
        }
        cursor = token_end;
    }
    output
}

fn redact_sensitive_assignment(token: &str) -> Option<String> {
    let (key, _) = token.split_once('=')?;
    is_sensitive_assignment_key(key).then(|| format!("{key}=[redacted]"))
}

fn is_sensitive_assignment_key(key: &str) -> bool {
    let key = key
        .trim_matches(|character: char| {
            matches!(
                character,
                '"' | '\'' | '`' | '(' | '[' | '{' | '<' | '-' | '/'
            )
        })
        .replace('-', "_")
        .to_ascii_uppercase();
    matches!(
        key.as_str(),
        "TOKEN"
            | "AUTH_TOKEN"
            | "ACCESS_TOKEN"
            | "REFRESH_TOKEN"
            | "ID_TOKEN"
            | "API_KEY"
            | "APIKEY"
            | "SECRET"
            | "CLIENT_SECRET"
            | "PASSWORD"
            | "PASSWD"
            | "PRIVATE_KEY"
            | "GITHUB_PAT"
            | "AWS_SECRET_ACCESS_KEY"
            | "AWS_SESSION_TOKEN"
    ) || key.ends_with("_TOKEN")
        || key.ends_with("_SECRET")
        || key.ends_with("_PASSWORD")
        || key.ends_with("_PASSWD")
        || key.ends_with("_API_KEY")
        || key.ends_with("_PRIVATE_KEY")
        || key.ends_with("_PAT")
}

fn looks_like_known_secret(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    (token.len() >= 16
        && (lower.starts_with("sk-")
            || lower.starts_with("ghp_")
            || lower.starts_with("gho_")
            || lower.starts_with("ghu_")
            || lower.starts_with("ghs_")
            || lower.starts_with("ghr_")
            || lower.starts_with("github_pat_")
            || lower.starts_with("xoxb-")
            || lower.starts_with("xoxp-")
            || lower.starts_with("xoxa-")
            || lower.starts_with("xoxr-")))
        || (token.len() >= 30 && token.starts_with("AIza"))
        || (token.len() == 20 && (token.starts_with("AKIA") || token.starts_with("ASIA")))
        || looks_like_jwt(token)
}

fn redact_json_document(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut parsed = serde_json::from_str::<Value>(trimmed).ok()?;
    if !redact_explicit_json_secrets(&mut parsed) {
        return None;
    }
    let start = value.len() - value.trim_start().len();
    let end = value.trim_end().len();
    let serialized = if trimmed.contains('\n') {
        serde_json::to_string_pretty(&parsed).ok()?
    } else {
        parsed.to_string()
    };
    Some(format!(
        "{}{}{}",
        &value[..start],
        serialized,
        &value[end..]
    ))
}

fn redact_explicit_json_secrets(value: &mut Value) -> bool {
    match value {
        Value::Object(fields) => {
            let mut changed = false;
            for (key, value) in fields {
                if is_sensitive_json_key(key) {
                    *value = Value::String("[redacted]".into());
                    changed = true;
                } else {
                    changed |= redact_explicit_json_secrets(value);
                }
            }
            changed
        }
        Value::Array(values) => {
            let mut changed = false;
            for value in values {
                changed |= redact_explicit_json_secrets(value);
            }
            changed
        }
        Value::String(text) => {
            let trimmed = text.trim();
            let replacement = if looks_like_known_secret(trimmed) {
                Some("[redacted]".into())
            } else if trimmed
                .get(..7)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("bearer "))
            {
                Some("Bearer [redacted]".into())
            } else if trimmed.contains("://") && trimmed.contains('@') {
                Some(redact_credential_url(text))
            } else if trimmed.to_ascii_uppercase().contains("-----BEGIN")
                && trimmed.to_ascii_uppercase().contains("PRIVATE KEY-----")
            {
                Some("[redacted-private-key]".into())
            } else {
                None
            };
            if let Some(replacement) = replacement {
                *text = replacement;
                true
            } else {
                false
            }
        }
        _ => false,
    }
}

fn is_sensitive_json_key(key: &str) -> bool {
    let key = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_lowercase())
        .collect::<String>();
    matches!(
        key.as_str(),
        "token"
            | "authtoken"
            | "accesstoken"
            | "refreshtoken"
            | "idtoken"
            | "sessiontoken"
            | "csrftoken"
            | "apikey"
            | "secret"
            | "clientsecret"
            | "password"
            | "passwd"
            | "privatekey"
            | "githubpat"
            | "authorization"
            | "cookie"
            | "setcookie"
            | "awssecretaccesskey"
    ) || key.ends_with("apikey")
        || key.ends_with("password")
        || key.ends_with("privatekey")
        || key.ends_with("clientsecret")
}

fn looks_like_jwt(token: &str) -> bool {
    let mut segments = token.split('.');
    let Some(header) = segments.next() else {
        return false;
    };
    let Some(payload) = segments.next() else {
        return false;
    };
    let Some(signature) = segments.next() else {
        return false;
    };
    segments.next().is_none()
        && header.starts_with("eyJ")
        && payload.len() >= 8
        && signature.len() >= 8
        && [header, payload, signature].into_iter().all(|segment| {
            segment.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
        })
}

pub(crate) fn bound_and_redact_patch(value: &str, limit: usize) -> (String, bool) {
    truncate_utf8(&redact_text(value), limit)
}

fn redact_credential_url(value: &str) -> String {
    let Some(scheme) = value.find("://") else {
        return "[redacted-url]".into();
    };
    let after = scheme + 3;
    let Some(at) = value[after..].find('@').map(|index| after + index) else {
        return value.into();
    };
    format!("{}[redacted]@{}", &value[..after], &value[at + 1..])
}

pub(crate) fn bounded_audit(value: &Value) -> (String, bool) {
    let redacted = redact_json(value, None);
    truncate_utf8(&redacted.to_string(), AUDIT_LIMIT)
}

/// Keep provider-labeled reasoning summaries available for diagnostics while
/// ensuring raw reasoning blocks never enter the persisted audit stream.
pub(crate) fn bounded_event_audit(value: &Value) -> (String, bool) {
    let is_reasoning_item = value
        .get("item")
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str)
        == Some("reasoning")
        || (value.get("type").and_then(Value::as_str) == Some("reasoning"));
    if !is_reasoning_item {
        return bounded_audit(value);
    }
    let mut sanitized = value.clone();
    let item = if sanitized.get("item").is_some() {
        sanitized.get_mut("item")
    } else {
        Some(&mut sanitized)
    };
    if let Some(item) = item.and_then(Value::as_object_mut) {
        item.remove("content");
    }
    bounded_audit(&sanitized)
}

fn redact_json(value: &Value, key: Option<&str>) -> Value {
    let sensitive_key = key.is_some_and(|key| {
        matches!(
            key.to_ascii_lowercase().as_str(),
            "stdin" | "environment" | "env" | "arguments" | "result" | "authorization" | "cookie"
        )
    });
    if sensitive_key {
        return Value::String("[redacted]".into());
    }
    match value {
        Value::String(text) => Value::String(bound_and_redact(text, TEXT_LIMIT).0),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .take(512)
                .map(|value| redact_json(value, key))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), redact_json(value, Some(key))))
                .collect::<Map<_, _>>(),
        ),
        primitive => primitive.clone(),
    }
}

fn truncate_utf8(value: &str, limit: usize) -> (String, bool) {
    if value.len() <= limit {
        return (value.into(), false);
    }
    let mut boundary = limit;
    while !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    (format!("{}\n[truncated]", &value[..boundary]), true)
}
