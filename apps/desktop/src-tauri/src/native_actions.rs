//! Provider-native skills and slash actions.
//!
//! Discovery stays in the native host. The renderer receives bounded display
//! metadata and opaque ids only; it never receives SKILL.md bodies, provider
//! settings, credential files, or filesystem paths.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
};

use integrator_core::ProviderKind;
use serde::Serialize;
use serde_json::Value;

const MAX_ACTIONS: usize = 512;
const MAX_METADATA_BYTES: u64 = 64 * 1024;
const MAX_TEXT: usize = 1_024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NativeActionInvocation {
    Direct,
    InteractiveOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NativeActionKind {
    Skill,
    Command,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProviderAction {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source: String,
    pub kind: NativeActionKind,
    pub invocation: NativeActionInvocation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_hint: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeActionHandle {
    pub provider: ProviderKind,
    pub repository: PathBuf,
    pub name: String,
    pub source: String,
    pub kind: NativeActionKind,
    pub invocation: NativeActionInvocation,
    pub provider_path: Option<PathBuf>,
}

#[derive(Clone, Debug)]
struct DiscoveredAction {
    name: String,
    description: String,
    source: String,
    kind: NativeActionKind,
    invocation: NativeActionInvocation,
}

impl NativeProviderAction {
    pub fn acp(name: &str, description: &str, input_hint: Option<&str>) -> Option<Self> {
        let name = bounded_token(name)?;
        Some(Self {
            id: String::new(),
            name,
            description: bounded_text(description, "Provider command"),
            source: "provider".into(),
            kind: NativeActionKind::Command,
            invocation: NativeActionInvocation::Direct,
            input_hint: input_hint.map(|value| bounded_text(value, "arguments")),
        })
    }
}

/// ACP's authoritative native command advertisement. Malformed rows are
/// ignored and the whole replacement is bounded before entering app state.
pub fn parse_acp_actions(update: &Value) -> Option<Vec<NativeProviderAction>> {
    if update.get("sessionUpdate").and_then(Value::as_str) != Some("available_commands_update") {
        return None;
    }
    let commands = update
        .get("availableCommands")
        .or_else(|| update.get("available_commands"))?
        .as_array()?;
    let mut actions = Vec::new();
    for command in commands.iter().take(MAX_ACTIONS) {
        let Some(name) = command.get("name").and_then(Value::as_str) else {
            continue;
        };
        let description = command
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("Provider command");
        let input_hint = command
            .pointer("/input/hint")
            .or_else(|| command.get("inputHint"))
            .and_then(Value::as_str);
        if let Some(action) = NativeProviderAction::acp(name, description, input_hint) {
            actions.push(action);
        }
    }
    Some(actions)
}

pub fn discover_file_actions(
    provider: &ProviderKind,
    repository: &Path,
) -> Vec<NativeProviderAction> {
    let discovered = match provider {
        ProviderKind::Claude => discover_claude(repository),
        ProviderKind::Antigravity => discover_antigravity(repository),
        _ => Vec::new(),
    };
    deduplicate_actions(
        discovered
            .into_iter()
            .take(MAX_ACTIONS)
            .map(|action| NativeProviderAction {
                id: String::new(),
                name: action.name,
                description: action.description,
                source: action.source,
                kind: action.kind,
                invocation: action.invocation,
                input_hint: None,
            })
            .collect(),
    )
}

fn discover_claude(repository: &Path) -> Vec<DiscoveredAction> {
    // This is the current provider-bundled catalog. Unknown future removals
    // fail safely at invocation in Claude itself.
    const BUNDLED: &[(&str, &str)] = &[
        ("batch", "Run a large change as coordinated parallel work"),
        ("claude-api", "Build with the Claude API or Anthropic SDK"),
        ("code-review", "Review code changes"),
        ("dataviz", "Create a data visualization"),
        ("debug", "Debug the current Claude Code session"),
        ("design-sync", "Synchronize implementation with a design"),
        ("doctor", "Diagnose the Claude Code installation"),
        (
            "fewer-permission-prompts",
            "Reduce repeated permission prompts",
        ),
        (
            "loop",
            "Run a recurring prompt while the Claude session remains open",
        ),
        ("run", "Run a supported Claude workflow"),
        ("run-skill-generator", "Generate a Claude skill"),
        ("simplify", "Simplify recently changed code"),
        ("verify", "Verify the implementation"),
    ];
    let mut actions = BUNDLED
        .iter()
        .map(|(name, description)| DiscoveredAction {
            name: (*name).into(),
            description: (*description).into(),
            source: "bundled".into(),
            kind: NativeActionKind::Skill,
            // `/loop` is session-resident. Integrator's primary Claude route
            // is one print process per turn, so direct send would create a
            // schedule and immediately tear down the process that owns it.
            invocation: if *name == "loop" {
                NativeActionInvocation::InteractiveOnly
            } else {
                NativeActionInvocation::Direct
            },
        })
        .collect::<Vec<_>>();
    actions.insert(
        0,
        DiscoveredAction {
            name: "goal".into(),
            description: "Keep working until a completion condition is met".into(),
            source: "built-in".into(),
            kind: NativeActionKind::Command,
            invocation: NativeActionInvocation::Direct,
        },
    );

    if let Some(home) = home_dir() {
        scan_skill_root(
            &home.join(".claude/skills"),
            "personal",
            None,
            NativeActionInvocation::Direct,
            &mut actions,
        );
        scan_command_root(
            &home.join(".claude/commands"),
            "personal",
            NativeActionInvocation::Direct,
            &mut actions,
        );
        scan_plugin_tree(
            &home.join(".claude/plugins"),
            "plugin",
            NativeActionInvocation::Direct,
            &mut actions,
        );
    }
    scan_repo_skill_dirs(
        repository,
        ".claude",
        "project",
        NativeActionInvocation::Direct,
        &mut actions,
    );
    actions
}

fn discover_antigravity(repository: &Path) -> Vec<DiscoveredAction> {
    let mut actions = Vec::new();
    if let Some(home) = home_dir() {
        for (root, source) in [
            (
                home.join(".gemini/antigravity-cli/builtin/skills"),
                "builtin",
            ),
            (home.join(".gemini/antigravity-cli/skills"), "personal"),
            (home.join(".gemini/config/skills"), "personal"),
        ] {
            scan_skill_root(
                &root,
                source,
                None,
                NativeActionInvocation::InteractiveOnly,
                &mut actions,
            );
        }
        scan_plugin_tree(
            &home.join(".gemini/antigravity-cli/plugins"),
            "plugin",
            NativeActionInvocation::InteractiveOnly,
            &mut actions,
        );
        scan_plugin_tree(
            &home.join(".gemini/config/plugins"),
            "plugin",
            NativeActionInvocation::InteractiveOnly,
            &mut actions,
        );
    }
    for root in [repository.join(".agents"), repository.join(".agent")] {
        scan_skill_root(
            &root.join("skills"),
            "project",
            None,
            NativeActionInvocation::InteractiveOnly,
            &mut actions,
        );
        scan_plugin_tree(
            &root.join("plugins"),
            "plugin",
            NativeActionInvocation::InteractiveOnly,
            &mut actions,
        );
    }
    scan_plugin_tree(
        &repository.join("_agents/plugins"),
        "plugin",
        NativeActionInvocation::InteractiveOnly,
        &mut actions,
    );
    actions
}

/// One Integrator-plane skill: the bounded display metadata plus the host-side
/// path used for projection. The path never crosses into the renderer.
#[derive(Clone, Debug)]
pub struct IntegratorSkillEntry {
    pub name: String,
    pub description: String,
    /// "integrator" (user Skills root), "plugin" (user Plugins root), or
    /// "first-party" (bundled with the app).
    pub source: String,
    /// The skill directory (containing SKILL.md) or a bare `<name>.md` file.
    pub path: PathBuf,
}

/// Scan the Integrator-owned skill roots. Standalone skills are namespaced
/// `integrator:<name>`; plugin skills are `<plugin>:<name>` so explicit slash
/// invocation matches the projected plugin's own naming. First match by name
/// wins: user skills shadow plugins, plugins shadow bundled first-party.
pub fn discover_integrator_skills(
    skills_root: &Path,
    plugins_root: &Path,
    bundled_root: Option<&Path>,
) -> Vec<IntegratorSkillEntry> {
    let mut entries = Vec::new();
    scan_integrator_skill_root(skills_root, Some("integrator"), "integrator", &mut entries);
    scan_integrator_plugin_tree(plugins_root, "plugin", &mut entries);
    if let Some(bundled) = bundled_root {
        scan_integrator_plugin_tree(bundled, "first-party", &mut entries);
    }
    let mut seen = HashSet::new();
    entries
        .into_iter()
        .filter(|entry| seen.insert(entry.name.clone()))
        .take(MAX_ACTIONS)
        .collect()
}

fn scan_integrator_skill_root(
    root: &Path,
    namespace: Option<&str>,
    source: &str,
    output: &mut Vec<IntegratorSkillEntry>,
) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten().take(MAX_ACTIONS) {
        if output.len() >= MAX_ACTIONS {
            break;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        let (metadata_path, skill_path) = if kind.is_dir() {
            (entry.path().join("SKILL.md"), entry.path())
        } else if entry.path().extension().and_then(|value| value.to_str()) == Some("md") {
            (entry.path(), entry.path())
        } else {
            continue;
        };
        let fallback = if kind.is_dir() {
            entry.file_name().to_string_lossy().into_owned()
        } else {
            entry
                .path()
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        };
        let Some(action) = read_action_file(
            &metadata_path,
            &fallback,
            source,
            NativeActionKind::Skill,
            NativeActionInvocation::Direct,
        ) else {
            continue;
        };
        let name = match namespace {
            Some(namespace) => format!("{namespace}:{}", action.name),
            None => action.name,
        };
        output.push(IntegratorSkillEntry {
            name,
            description: action.description,
            source: source.into(),
            path: skill_path,
        });
    }
}

/// Each top-level directory in the plugins root is one plugin; its name is
/// the namespace. Inside a plugin, skills are found wherever the ecosystem
/// puts them: `skills/` collections (Claude-plugin layout) or any descendant
/// directory holding a SKILL.md (bare catalog repos like `anthropics/skills`
/// or `openai/skills`, whose skill folders sit at the repository root).
fn scan_integrator_plugin_tree(root: &Path, source: &str, output: &mut Vec<IntegratorSkillEntry>) {
    let Ok(plugins) = fs::read_dir(root) else {
        return;
    };
    for plugin in plugins.flatten().take(256) {
        let Ok(kind) = plugin.file_type() else {
            continue;
        };
        if !kind.is_dir()
            || kind.is_symlink()
            || plugin.file_name().to_string_lossy().starts_with('.')
        {
            continue;
        }
        let plugin_name = plugin.file_name().to_string_lossy().into_owned();
        scan_plugin_dir(&plugin.path(), &plugin_name, source, output);
    }
}

fn scan_plugin_dir(
    root: &Path,
    namespace: &str,
    source: &str,
    output: &mut Vec<IntegratorSkillEntry>,
) {
    let mut queue = VecDeque::from([(root.to_path_buf(), 0usize)]);
    let mut visited = 0usize;
    while let Some((directory, depth)) = queue.pop_front() {
        if depth > 6 || visited >= 2_048 || output.len() >= MAX_ACTIONS {
            break;
        }
        visited += 1;
        // A directory owning a SKILL.md is one skill; its bundled resources
        // are not walked further. This includes a plugin whose repository
        // root is itself a single skill.
        if directory.join("SKILL.md").is_file() {
            let fallback = directory
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            if let Some(action) = read_action_file(
                &directory.join("SKILL.md"),
                &fallback,
                source,
                NativeActionKind::Skill,
                NativeActionInvocation::Direct,
            ) {
                output.push(IntegratorSkillEntry {
                    name: format!("{namespace}:{}", action.name),
                    description: action.description,
                    source: source.into(),
                    path: directory,
                });
            }
            continue;
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten().take(256) {
            let name = entry.file_name();
            if matches!(
                name.to_str(),
                Some(".git" | "node_modules" | "target" | ".next")
            ) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if !kind.is_dir() || kind.is_symlink() {
                continue;
            }
            if name.to_string_lossy().eq_ignore_ascii_case("skills") {
                // Claude-plugin layout: `skills/` also hosts bare `.md`
                // skills that the SKILL.md walk above cannot represent.
                scan_integrator_skill_root(&entry.path(), Some(namespace), source, output);
                // Some catalogs (notably openai/skills) put their skill
                // folders below categorization directories such as
                // `skills/.curated/<name>/SKILL.md`. Preserve the shallow
                // scan above for bare `.md` files, then continue walking
                // directories that do not already own a SKILL.md.
                if let Ok(nested) = fs::read_dir(entry.path()) {
                    for child in nested.flatten().take(256) {
                        let Ok(kind) = child.file_type() else {
                            continue;
                        };
                        if kind.is_dir()
                            && !kind.is_symlink()
                            && !child.path().join("SKILL.md").is_file()
                        {
                            queue.push_back((child.path(), depth + 1));
                        }
                    }
                }
            } else {
                queue.push_back((entry.path(), depth + 1));
            }
        }
    }
}

fn scan_repo_skill_dirs(
    repository: &Path,
    marker: &str,
    source: &str,
    invocation: NativeActionInvocation,
    output: &mut Vec<DiscoveredAction>,
) {
    let mut queue = VecDeque::from([repository.to_path_buf()]);
    let mut visited = 0usize;
    while let Some(directory) = queue.pop_front() {
        if visited >= 2_048 || output.len() >= MAX_ACTIONS {
            break;
        }
        visited += 1;
        scan_skill_root(
            &directory.join(marker).join("skills"),
            source,
            None,
            invocation,
            output,
        );
        scan_command_root(
            &directory.join(marker).join("commands"),
            source,
            invocation,
            output,
        );
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if matches!(
                name.to_str(),
                Some(".git" | "node_modules" | "target" | ".next")
            ) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() && !kind.is_symlink() {
                queue.push_back(entry.path());
            }
        }
    }
}

fn scan_plugin_tree(
    root: &Path,
    source: &str,
    invocation: NativeActionInvocation,
    output: &mut Vec<DiscoveredAction>,
) {
    let mut queue = VecDeque::from([(root.to_path_buf(), 0usize)]);
    let mut visited = 0usize;
    while let Some((directory, depth)) = queue.pop_front() {
        if depth > 6 || visited >= 2_048 || output.len() >= MAX_ACTIONS {
            continue;
        }
        visited += 1;
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten().take(256) {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if !kind.is_dir() || kind.is_symlink() {
                continue;
            }
            if entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case("skills")
            {
                let parent = entry.path().parent().map(Path::to_path_buf);
                let mut plugin_name = parent
                    .as_deref()
                    .and_then(Path::file_name)
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned();
                if looks_like_version(&plugin_name)
                    && let Some(name) = parent
                        .as_deref()
                        .and_then(Path::parent)
                        .and_then(Path::file_name)
                {
                    plugin_name = name.to_string_lossy().into_owned();
                }
                scan_skill_root(
                    &entry.path(),
                    source,
                    Some(&plugin_name),
                    invocation,
                    output,
                );
            } else {
                queue.push_back((entry.path(), depth + 1));
            }
        }
    }
}

fn looks_like_version(value: &str) -> bool {
    value
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_digit())
        && value.contains('.')
}

fn scan_skill_root(
    root: &Path,
    source: &str,
    namespace: Option<&str>,
    invocation: NativeActionInvocation,
    output: &mut Vec<DiscoveredAction>,
) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten().take(MAX_ACTIONS) {
        if output.len() >= MAX_ACTIONS {
            break;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        let path = if kind.is_dir() {
            entry.path().join("SKILL.md")
        } else if entry.path().extension().and_then(|value| value.to_str()) == Some("md") {
            entry.path()
        } else {
            continue;
        };
        let fallback = if kind.is_dir() {
            entry.file_name().to_string_lossy().into_owned()
        } else {
            entry
                .path()
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        };
        let Some(mut action) = read_action_file(
            &path,
            &fallback,
            source,
            NativeActionKind::Skill,
            invocation,
        ) else {
            continue;
        };
        if let Some(namespace) = namespace {
            action.name = format!("{namespace}:{}", action.name);
        }
        output.push(action);
    }
}

fn scan_command_root(
    root: &Path,
    source: &str,
    invocation: NativeActionInvocation,
    output: &mut Vec<DiscoveredAction>,
) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten().take(MAX_ACTIONS) {
        if output.len() >= MAX_ACTIONS {
            break;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if !kind.is_file()
            || kind.is_symlink()
            || path.extension().and_then(|value| value.to_str()) != Some("md")
        {
            continue;
        }
        let fallback = path.file_stem().unwrap_or_default().to_string_lossy();
        if let Some(action) = read_action_file(
            &path,
            &fallback,
            source,
            NativeActionKind::Command,
            invocation,
        ) {
            output.push(action);
        }
    }
}

fn read_action_file(
    path: &Path,
    fallback_name: &str,
    source: &str,
    kind: NativeActionKind,
    invocation: NativeActionInvocation,
) -> Option<DiscoveredAction> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_METADATA_BYTES
    {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    let frontmatter = parse_frontmatter(&content);
    if frontmatter
        .get("user-invocable")
        .is_some_and(|value| value.eq_ignore_ascii_case("false"))
    {
        return None;
    }
    let name = bounded_token(
        frontmatter
            .get("name")
            .map(String::as_str)
            .unwrap_or(fallback_name),
    )?;
    let description = frontmatter
        .get("description")
        .map(String::as_str)
        .map(|value| bounded_text(value, "Provider skill"))
        .unwrap_or_else(|| "Provider skill".into());
    Some(DiscoveredAction {
        name,
        description,
        source: bounded_text(source, "provider"),
        kind,
        invocation,
    })
}

/// Parses the bounded set of frontmatter keys this app reads. Handles plain
/// `key: value` lines and YAML block scalars (`description: >-` / `|` with
/// the real text on the following more-indented lines) — the latter is
/// common in larger third-party catalogs (e.g. google/skills) and, without
/// this, silently degraded every description to the literal `>-` marker.
pub(crate) fn parse_frontmatter(content: &str) -> HashMap<String, String> {
    let mut values = HashMap::new();
    let mut lines = content.lines().peekable();
    if lines.next().map(str::trim) != Some("---") {
        return values;
    }
    let mut consumed = 0usize;
    while let Some(line) = lines.next() {
        consumed += 1;
        if consumed > 128 {
            break;
        }
        if line.trim() == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        if !matches!(key.as_str(), "name" | "description" | "user-invocable") {
            continue;
        }
        let value = value.trim();
        if matches!(value, ">" | ">-" | ">+" | "|" | "|-" | "|+") {
            let mut block = String::new();
            while let Some(next) = lines.peek() {
                if next.trim().is_empty() {
                    lines.next();
                    consumed += 1;
                    continue;
                }
                if next.len() - next.trim_start().len() == 0 {
                    break;
                }
                if !block.is_empty() {
                    block.push(' ');
                }
                block.push_str(next.trim());
                lines.next();
                consumed += 1;
                if consumed > 128 {
                    break;
                }
            }
            if !block.is_empty() {
                values.insert(key, block);
            }
        } else {
            values.insert(key, value.trim_matches(['\'', '"']).to_owned());
        }
    }
    values
}

fn bounded_token(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 256
        || !trimmed.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.')
        })
    {
        return None;
    }
    Some(trimmed.to_owned())
}

fn bounded_text(value: &str, fallback: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let bounded = normalized.chars().take(MAX_TEXT).collect::<String>();
    if bounded.is_empty() {
        fallback.into()
    } else {
        bounded
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

pub fn deduplicate_actions(actions: Vec<NativeProviderAction>) -> Vec<NativeProviderAction> {
    let mut seen = HashSet::new();
    actions
        .into_iter()
        .filter(|action| seen.insert((action.name.clone(), action.source.clone())))
        .take(MAX_ACTIONS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acp_inventory_is_bounded_and_rejects_adversarial_names() {
        let update = serde_json::json!({
            "sessionUpdate": "available_commands_update",
            "availableCommands": [
                { "name": "loop", "description": "Repeat a prompt", "input": { "hint": "5m do work" } },
                { "name": "../escape", "description": "bad" },
                { "name": "local:commit", "description": "Commit locally" }
            ]
        });
        let actions = parse_acp_actions(&update).expect("command update");
        assert_eq!(actions.len(), 2);
        assert_eq!(actions[0].name, "loop");
        assert_eq!(actions[0].input_hint.as_deref(), Some("5m do work"));
        assert_eq!(actions[1].name, "local:commit");
    }

    #[test]
    fn frontmatter_parser_never_returns_instruction_body() {
        let parsed = parse_frontmatter("---\nname: safe\ndescription: bounded\n---\nSECRET BODY");
        assert_eq!(parsed.get("name").map(String::as_str), Some("safe"));
        assert!(!parsed.values().any(|value| value.contains("SECRET")));
    }

    #[test]
    fn frontmatter_parser_folds_yaml_block_scalar_descriptions() {
        // Real shape from google/skills: a folded block scalar whose text
        // lives on the following indented lines, not after the colon.
        let content = "---\nname: data-manager-api-audience-ingestion\ndescription: >-\n  Guides developers through uploading audience members to Google products using\n  the Data Manager API. Use this skill when the user wants to upload audience\n  members.\nmetadata:\n  version: 1.1\n---\nBODY";
        let parsed = parse_frontmatter(content);
        assert_eq!(
            parsed.get("name").map(String::as_str),
            Some("data-manager-api-audience-ingestion")
        );
        let description = parsed.get("description").expect("description parsed");
        assert!(!description.contains(">-"));
        assert!(description.contains("Guides developers"));
        assert!(description.contains("members."));
    }

    #[test]
    fn nested_plugin_skills_are_namespaced_and_oversized_metadata_is_skipped() {
        let root = std::env::temp_dir().join(format!("native-actions-{}", uuid::Uuid::new_v4()));
        let skill = root
            .join("cache")
            .join("marketplace")
            .join("science")
            .join("1.2.3")
            .join("skills")
            .join("plot-data");
        fs::create_dir_all(&skill).expect("create plugin skill fixture");
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: plot-data\ndescription: Plot a dataset\n---\nPRIVATE INSTRUCTIONS",
        )
        .expect("write plugin skill fixture");
        let oversized = root.join("skills").join("too-large");
        fs::create_dir_all(&oversized).expect("create oversized fixture");
        fs::write(
            oversized.join("SKILL.md"),
            "x".repeat((MAX_METADATA_BYTES + 1) as usize),
        )
        .expect("write oversized fixture");

        let mut actions = Vec::new();
        scan_plugin_tree(
            &root,
            "plugin",
            NativeActionInvocation::Direct,
            &mut actions,
        );
        assert!(actions.iter().any(|action| {
            action.name == "science:plot-data" && action.description == "Plot a dataset"
        }));
        scan_skill_root(
            &root.join("skills"),
            "project",
            None,
            NativeActionInvocation::Direct,
            &mut actions,
        );
        assert!(!actions.iter().any(|action| action.name == "too-large"));
        fs::remove_dir_all(root).expect("clean up native action fixtures");
    }

    #[test]
    fn integrator_discovery_namespaces_shadows_and_rejects_symlinks() {
        let root = std::env::temp_dir().join(format!("integrator-skills-{}", uuid::Uuid::new_v4()));
        let skills = root.join("Skills");
        let plugins = root.join("Plugins");
        let bundled = root.join("bundled");
        fs::create_dir_all(skills.join("fred")).expect("skills fixture");
        fs::write(
            skills.join("fred").join("SKILL.md"),
            "---\nname: fred\ndescription: User copy\n---\nBODY",
        )
        .expect("user skill");
        fs::create_dir_all(plugins.join("gov-data").join("skills").join("fred"))
            .expect("plugin fixture");
        fs::write(
            plugins
                .join("gov-data")
                .join("skills")
                .join("fred")
                .join("SKILL.md"),
            "---\nname: fred\ndescription: FRED data\n---\nBODY",
        )
        .expect("plugin skill");
        fs::create_dir_all(bundled.join("gov-data").join("skills").join("fred"))
            .expect("bundled fixture");
        fs::write(
            bundled
                .join("gov-data")
                .join("skills")
                .join("fred")
                .join("SKILL.md"),
            "---\nname: fred\ndescription: Bundled copy\n---\nBODY",
        )
        .expect("bundled skill");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&skills, skills.join("escape")).expect("symlink fixture");

        let entries = discover_integrator_skills(&skills, &plugins, Some(&bundled));
        assert!(
            entries
                .iter()
                .any(|entry| entry.name == "integrator:fred" && entry.source == "integrator")
        );
        // Same plugin name across Plugins and bundled: the user's install wins.
        let plugin_copies = entries
            .iter()
            .filter(|entry| entry.name == "gov-data:fred")
            .collect::<Vec<_>>();
        assert_eq!(plugin_copies.len(), 1);
        assert_eq!(plugin_copies[0].source, "plugin");
        assert_eq!(plugin_copies[0].description, "FRED data");
        assert!(!entries.iter().any(|entry| entry.name.contains("escape")));
        fs::remove_dir_all(root).expect("clean up integrator fixtures");
    }

    #[test]
    fn integrator_plugin_scan_handles_bare_catalog_repos() {
        let root =
            std::env::temp_dir().join(format!("integrator-catalog-{}", uuid::Uuid::new_v4()));
        let plugins = root.join("Plugins");
        // anthropics/skills style: skill dirs at the repository root.
        let pdf = plugins.join("anthropics-skills").join("pdf");
        fs::create_dir_all(pdf.join("scripts")).expect("catalog fixture");
        fs::write(
            pdf.join("SKILL.md"),
            "---\nname: pdf\ndescription: Work with PDFs\n---\nBODY",
        )
        .expect("catalog skill");
        // Nested resources under a skill are not themselves skills.
        fs::write(
            pdf.join("scripts").join("SKILL.md"),
            "---\nname: fake\n---\n",
        )
        .expect("nested fixture");
        let entries = discover_integrator_skills(&root.join("Skills"), &plugins, None);
        assert!(
            entries
                .iter()
                .any(|entry| entry.name == "anthropics-skills:pdf")
        );
        assert!(!entries.iter().any(|entry| entry.name.contains("fake")));
        fs::remove_dir_all(root).expect("clean up catalog fixtures");
    }

    #[test]
    fn integrator_plugin_scan_handles_categorized_skill_catalogs() {
        let root = std::env::temp_dir().join(format!(
            "integrator-categorized-catalog-{}",
            uuid::Uuid::new_v4()
        ));
        let plugins = root.join("Plugins");
        let curated = plugins
            .join("openai-skills")
            .join("skills")
            .join(".curated")
            .join("pdf");
        let system = plugins
            .join("openai-skills")
            .join("skills")
            .join(".system")
            .join("skill-installer");
        fs::create_dir_all(&curated).expect("curated catalog fixture");
        fs::create_dir_all(&system).expect("system catalog fixture");
        fs::write(
            curated.join("SKILL.md"),
            "---\nname: pdf\ndescription: Work with PDFs\n---\nBODY",
        )
        .expect("curated skill");
        fs::write(
            system.join("SKILL.md"),
            "---\nname: skill-installer\ndescription: Install skills\n---\nBODY",
        )
        .expect("system skill");

        let entries = discover_integrator_skills(&root.join("Skills"), &plugins, None);
        assert!(entries.iter().any(|entry| {
            entry.name == "openai-skills:pdf" && entry.description == "Work with PDFs"
        }));
        assert!(entries.iter().any(|entry| {
            entry.name == "openai-skills:skill-installer" && entry.description == "Install skills"
        }));
        fs::remove_dir_all(root).expect("clean up categorized catalog fixture");
    }

    #[test]
    fn claude_goal_is_a_direct_provider_command() {
        let actions = discover_file_actions(&ProviderKind::Claude, Path::new("."));
        let goal = actions
            .iter()
            .find(|action| action.name == "goal")
            .expect("Claude goal command");
        assert_eq!(goal.kind, NativeActionKind::Command);
        assert_eq!(goal.invocation, NativeActionInvocation::Direct);
        assert_eq!(goal.source, "built-in");
    }
}
