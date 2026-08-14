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

/// `agy models` prints one bare slug per line (`gemini-3.6-flash-high`),
/// with the reasoning level baked into the id.
pub(crate) fn parse_antigravity_models(output: &str) -> Vec<String> {
    let mut models = Vec::new();
    for line in output.lines() {
        let Some(model) = line.split_whitespace().next() else {
            continue;
        };
        push_model_id(&mut models, model);
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
