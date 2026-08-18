use serde::Serialize;
use serde_json::Value;

fn push_model_id(models: &mut Vec<String>, model: &str) {
    if !model.is_empty()
        && model.len() <= 256
        && !model.starts_with('/')
        && !model.contains("..")
        && model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._/:".contains(&byte))
        && !models.iter().any(|existing| existing == model)
    {
        models.push(model.to_owned());
    }
}

fn grok_listed_model(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix(['*', '-', '+'])?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    rest.split_whitespace().next()
}

fn grok_default_model(line: &str) -> Option<&str> {
    line.trim()
        .split_once(':')
        .filter(|(label, _)| label.eq_ignore_ascii_case("default model"))
        .and_then(|(_, rest)| rest.split_whitespace().next())
}

pub(crate) fn parse_grok_models(output: &str) -> Vec<String> {
    let mut models = Vec::new();
    let mut default_model = None;
    for line in output.lines() {
        if let Some(model) = grok_default_model(line) {
            default_model = Some(model.to_owned());
        }
        if let Some(model) = grok_listed_model(line) {
            push_model_id(&mut models, model);
        }
    }
    if models.is_empty()
        && let Some(model) = default_model
    {
        push_model_id(&mut models, &model);
    }
    models
}

fn normalized_antigravity_model(line: &str) -> Option<String> {
    let model = line.trim();
    if model.is_empty()
        || model.len() > 256
        || model.starts_with('/')
        || model.contains("..")
        || model.ends_with(':')
        || !model.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || byte.is_ascii_whitespace()
                || b"-._/:()+[]".contains(&byte)
        })
    {
        return None;
    }
    let normalized = model.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = normalized.to_ascii_lowercase();
    let single_token = !normalized.contains(' ')
        && (normalized.bytes().any(|byte| byte.is_ascii_digit())
            || normalized.contains('-')
            || matches!(lower.as_str(), "auto" | "flash" | "pro"));
    let branded_display_name = ["gemini ", "claude ", "gpt-", "gpt "]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
        && normalized.bytes().any(|byte| byte.is_ascii_digit());
    (single_token || branded_display_name).then_some(normalized)
}

fn push_antigravity_model(models: &mut Vec<String>, value: &str) {
    let Some(model) = normalized_antigravity_model(value) else {
        return;
    };
    if !models.contains(&model) {
        models.push(model);
    }
}

fn collect_antigravity_json_models(value: &Value, models: &mut Vec<String>) {
    match value {
        Value::String(model) => push_antigravity_model(models, model),
        Value::Array(entries) => {
            for entry in entries {
                match entry {
                    Value::String(model) => push_antigravity_model(models, model),
                    Value::Object(object) => {
                        for key in ["id", "slug", "model", "name", "displayName", "display_name"] {
                            if let Some(Value::String(model)) = object.get(key) {
                                push_antigravity_model(models, model);
                                break;
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        Value::Object(object) => {
            for key in ["models", "data", "items"] {
                if let Some(nested) = object.get(key) {
                    collect_antigravity_json_models(nested, models);
                }
            }
        }
        _ => {}
    }
}

/// Current `agy --output-format json models` builds return a machine-readable
/// inventory. The line parser remains as a bounded compatibility fallback for
/// older builds, accepting only model-shaped slugs or branded display names.
pub(crate) fn parse_antigravity_models(output: &str) -> Vec<String> {
    let mut models = Vec::new();
    if let Ok(value) = serde_json::from_str::<Value>(output.trim()) {
        collect_antigravity_json_models(&value, &mut models);
        if !models.is_empty() {
            return models;
        }
    }
    for line in output.lines() {
        push_antigravity_model(&mut models, line);
    }
    models
}

/// One entry from Claude Code's `list_models` control response, reduced to
/// the fields the renderer's model picker needs. `id` is the CLI's
/// `resolvedModel` (`claude-opus-5[1m]`), which `--model` accepts verbatim.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModelEntry {
    pub id: String,
    pub label: String,
    pub efforts: Vec<String>,
}

/// Effort slugs `claude --effort` accepts; anything else from the catalog is
/// dropped rather than forwarded to the renderer.
const CLAUDE_EFFORT_SLUGS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// Claude ids may carry a `[1m]` context suffix, so square brackets join the
/// byte set used for the other provider model ids.
fn valid_claude_model_id(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 256
        && !model.starts_with('/')
        && !model.contains("..")
        && model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._/:[]".contains(&byte))
}

/// Parse the bounded renderer-safe subset of Claude's `list_models` control
/// response. Unknown records and aliases fail closed instead of being guessed.
pub(crate) fn parse_claude_models(output: &str) -> Vec<ClaudeModelEntry> {
    for line in output.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("control_response") {
            continue;
        }
        let Some(models) = value
            .pointer("/response/response/models")
            .and_then(Value::as_array)
        else {
            continue;
        };
        let mut entries: Vec<ClaudeModelEntry> = Vec::new();
        for model in models {
            if model.get("value").and_then(Value::as_str) == Some("default") {
                continue;
            }
            let Some(id) = model
                .get("resolvedModel")
                .or_else(|| model.get("value"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            if !valid_claude_model_id(id) || entries.iter().any(|entry| entry.id == id) {
                continue;
            }
            let label = model
                .get("displayName")
                .and_then(Value::as_str)
                .map(|label| {
                    label
                        .chars()
                        .filter(|ch| !ch.is_control())
                        .take(64)
                        .collect::<String>()
                        .trim()
                        .to_owned()
                })
                .filter(|label| !label.is_empty())
                .unwrap_or_else(|| id.to_owned());
            let efforts = model
                .get("supportedEffortLevels")
                .and_then(Value::as_array)
                .map(|levels| {
                    levels
                        .iter()
                        .filter_map(Value::as_str)
                        .filter(|level| CLAUDE_EFFORT_SLUGS.contains(level))
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            entries.push(ClaudeModelEntry {
                id: id.to_owned(),
                label,
                efforts,
            });
        }
        if !entries.is_empty() {
            return entries;
        }
    }
    Vec::new()
}
