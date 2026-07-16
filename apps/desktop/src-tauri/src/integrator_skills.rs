//! Integrator-plane skills: the user-owned Documents roots, bundled
//! first-party plugins, enablement, GitHub installs, and the per-turn Claude
//! projection overlay.
//!
//! Contract (docs/universal-capabilities.md): content lives in the
//! user-visible Documents roots, state lives in app-data, vendor stores are
//! never written, and the renderer receives bounded metadata only — never
//! skill bodies or filesystem paths of individual skills.

use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
};

use integrator_runtime::GithubCliService;
use serde::Serialize;
use serde_json::Value;
use session_store::LocalStore;
use tauri::Manager;

use crate::commands::{CommandError, CommandResult};
use crate::native_actions::{IntegratorSkillEntry, discover_integrator_skills};
use crate::state::AppState;

/// Written by the renderer through the standard settings path
/// (`setSetting("skills.integrator.enabled", …)` prefixes `settings.`).
const ENABLED_SETTING_KEY: &str = "settings.skills.integrator.enabled";
const SKILL_CREDENTIAL_SERVICE: &str = "dev.aiintegrator.skill-credential";
const PROJECTION_DIR: &str = "skills-projection";
/// Per-skill copy bounds for the projection overlay. Oversized content is
/// skipped file-by-file so one huge reference file cannot block a skill.
const MAX_PROJECTED_FILES: usize = 64;
const MAX_PROJECTED_FILE_BYTES: u64 = 512 * 1024;
const MAX_PROJECTED_DEPTH: usize = 4;

pub fn skills_root(documents: &Path) -> PathBuf {
    documents.join("AI Integrator").join("Skills")
}

pub fn plugins_root(documents: &Path) -> PathBuf {
    documents.join("AI Integrator").join("Plugins")
}

fn documents_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().document_dir().ok()
}

/// Create the user-visible roots. Best-effort at startup: a machine without a
/// Documents folder degrades to discovery finding nothing.
pub fn ensure_roots(app: &tauri::AppHandle) -> io::Result<()> {
    let Some(documents) = documents_dir(app) else {
        return Ok(());
    };
    fs::create_dir_all(skills_root(&documents))?;
    fs::create_dir_all(plugins_root(&documents))?;
    Ok(())
}

/// First-party plugins bundled with the app. Release builds resolve the
/// bundled resource tree; dev builds fall back to the repository checkout so
/// `tauri dev` exercises the same catalog without a packaging step.
fn bundled_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join("first-party-plugins");
        if bundled.is_dir() {
            return Some(bundled);
        }
    }
    if cfg!(debug_assertions) {
        let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../first-party/plugins");
        if checkout.is_dir() {
            return Some(checkout);
        }
    }
    None
}

/// Default enablement: user-authored skills are on (placing a folder in the
/// Skills root is the opt-in); installed and bundled plugins are off until
/// toggled, except the authoring skill the product leads with.
pub fn default_enabled(name: &str) -> bool {
    name.starts_with("integrator:") || name == "integrator-authoring:skill-creator"
}

fn enabled_overrides(store: &LocalStore) -> serde_json::Map<String, Value> {
    store
        .get_setting(ENABLED_SETTING_KEY)
        .ok()
        .flatten()
        .and_then(|setting| match setting.value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

fn is_enabled(overrides: &serde_json::Map<String, Value>, name: &str) -> bool {
    overrides
        .get(name)
        .and_then(Value::as_bool)
        .unwrap_or_else(|| default_enabled(name))
}

fn discover_all(app: &tauri::AppHandle) -> Vec<IntegratorSkillEntry> {
    let Some(documents) = documents_dir(app) else {
        return Vec::new();
    };
    discover_integrator_skills(
        &skills_root(&documents),
        &plugins_root(&documents),
        bundled_root(app).as_deref(),
    )
}

/// The enabled Integrator skills for one launch. Used by discovery merging
/// and by the Claude projection.
pub fn enabled_skills(app: &tauri::AppHandle, store: &LocalStore) -> Vec<IntegratorSkillEntry> {
    let overrides = enabled_overrides(store);
    discover_all(app)
        .into_iter()
        .filter(|entry| is_enabled(&overrides, &entry.name))
        .collect()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegratorSkillInfo {
    pub name: String,
    pub description: String,
    pub source: String,
    pub enabled: bool,
    pub default_enabled: bool,
    pub invocation_count: u64,
    pub credential: Option<IntegratorSkillCredentialInfo>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegratorSkillCredentialInfo {
    pub id: String,
    pub label: String,
    pub required: bool,
    pub configured: bool,
    pub available: bool,
    pub help_url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegratorSkillsOverview {
    pub skills_root: String,
    pub plugins_root: String,
    pub bundled_available: bool,
    pub skills: Vec<IntegratorSkillInfo>,
}

fn overview(app: &tauri::AppHandle, store: &LocalStore) -> CommandResult<IntegratorSkillsOverview> {
    let documents = documents_dir(app).ok_or(CommandError {
        code: "unavailable",
        message: "could not locate the Documents folder".into(),
    })?;
    let overrides = enabled_overrides(store);
    let invocation_counts = store.skill_invocation_counts().map_err(CommandError::from)?;
    let skills = discover_all(app)
        .into_iter()
        .map(|entry| {
            let credential = credential_definition(&entry)
                .map(|definition| credential_info(definition));
            IntegratorSkillInfo {
                enabled: is_enabled(&overrides, &entry.name),
                default_enabled: default_enabled(&entry.name),
                invocation_count: invocation_counts.get(&entry.name).copied().unwrap_or(0),
                credential,
                name: entry.name,
                description: entry.description,
                source: entry.source,
            }
        })
        .collect();
    Ok(IntegratorSkillsOverview {
        skills_root: skills_root(&documents).to_string_lossy().into_owned(),
        plugins_root: plugins_root(&documents).to_string_lossy().into_owned(),
        bundled_available: bundled_root(app).is_some(),
        skills,
    })
}

#[derive(Clone, Copy)]
struct SkillCredentialDefinition {
    id: &'static str,
    label: &'static str,
    required: bool,
    help_url: &'static str,
}

const FRED_CREDENTIAL: SkillCredentialDefinition = SkillCredentialDefinition {
    id: "fred-api-key",
    label: "FRED API key",
    required: true,
    help_url: "https://fred.stlouisfed.org/docs/api/api_key.html",
};
const BLS_CREDENTIAL: SkillCredentialDefinition = SkillCredentialDefinition {
    id: "bls-api-key",
    label: "BLS registration key",
    required: false,
    help_url: "https://data.bls.gov/registrationEngine/",
};
const CENSUS_CREDENTIAL: SkillCredentialDefinition = SkillCredentialDefinition {
    id: "census-api-key",
    label: "Census API key",
    required: false,
    help_url: "https://api.census.gov/data/key_signup.html",
};
const EIA_CREDENTIAL: SkillCredentialDefinition = SkillCredentialDefinition {
    id: "eia-api-key",
    label: "EIA API key",
    required: true,
    help_url: "https://www.eia.gov/opendata/register.php",
};
const ALPHA_VANTAGE_CREDENTIAL: SkillCredentialDefinition = SkillCredentialDefinition {
    id: "alpha-vantage-api-key",
    label: "Alpha Vantage API key",
    required: false,
    help_url: "https://www.alphavantage.co/support/#api-key",
};

fn credential_definition(entry: &IntegratorSkillEntry) -> Option<SkillCredentialDefinition> {
    if entry.source != "first-party" {
        return None;
    }
    match entry.name.as_str() {
        "gov-data:fred" => Some(FRED_CREDENTIAL),
        "gov-data:bls" => Some(BLS_CREDENTIAL),
        "gov-data:census" => Some(CENSUS_CREDENTIAL),
        "gov-data:eia" => Some(EIA_CREDENTIAL),
        "market-data:market-data" => Some(ALPHA_VANTAGE_CREDENTIAL),
        _ => None,
    }
}

fn credential_by_id(id: &str) -> Option<SkillCredentialDefinition> {
    [
        FRED_CREDENTIAL,
        BLS_CREDENTIAL,
        CENSUS_CREDENTIAL,
        EIA_CREDENTIAL,
        ALPHA_VANTAGE_CREDENTIAL,
    ]
    .into_iter()
    .find(|definition| definition.id == id)
}

fn skill_credential_entry(id: &str) -> CommandResult<keyring::Entry> {
    keyring::Entry::new(SKILL_CREDENTIAL_SERVICE, id).map_err(|_| CommandError {
        code: "credential-store-unavailable",
        message: "The operating system credential store is unavailable.".into(),
    })
}

fn credential_info(definition: SkillCredentialDefinition) -> IntegratorSkillCredentialInfo {
    let status = skill_credential_entry(definition.id).and_then(|entry| match entry.get_password() {
        Ok(value) => Ok(!value.is_empty()),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(_) => Err(CommandError {
            code: "credential-store-unavailable",
            message: "The operating system credential store could not be read.".into(),
        }),
    });
    IntegratorSkillCredentialInfo {
        id: definition.id.into(),
        label: definition.label.into(),
        required: definition.required,
        configured: status.as_ref().copied().unwrap_or(false),
        available: status.is_ok(),
        help_url: definition.help_url.into(),
    }
}

#[tauri::command]
pub fn integrator_skill_credential_set(
    credential_id: String,
    secret: String,
) -> CommandResult<()> {
    let id = credential_id.trim();
    let Some(definition) = credential_by_id(id) else {
        return Err(CommandError {
            code: "invalid-input",
            message: "Unknown skill credential.".into(),
        });
    };
    let value = secret.trim();
    if value.is_empty() || value.chars().count() > 4_096 {
        return Err(CommandError {
            code: "invalid-input",
            message: format!("Paste a valid {} before saving.", definition.label),
        });
    }
    skill_credential_entry(definition.id)?
        .set_password(value)
        .map_err(|_| CommandError {
            code: "credential-store-unavailable",
            message: format!(
                "The {} could not be saved to the operating system credential store.",
                definition.label
            ),
        })
}

#[tauri::command]
pub fn integrator_skill_credential_clear(credential_id: String) -> CommandResult<()> {
    let id = credential_id.trim();
    let Some(definition) = credential_by_id(id) else {
        return Err(CommandError {
            code: "invalid-input",
            message: "Unknown skill credential.".into(),
        });
    };
    match skill_credential_entry(definition.id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(CommandError {
            code: "credential-store-unavailable",
            message: format!(
                "The {} could not be removed from the operating system credential store.",
                definition.label
            ),
        }),
    }
}

#[tauri::command]
pub async fn integrator_skills_overview(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> CommandResult<IntegratorSkillsOverview> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || overview(&app, &store))
        .await
        .map_err(|_| CommandError {
            code: "unavailable",
            message: "skills discovery worker failed".into(),
        })?
}

/// Install one plugin repository (`owner/name`) into the user's Plugins root
/// via the GitHub CLI — the same vendor-owned network path project cloning
/// uses. Installs land disabled by default; enabling is an explicit toggle.
#[tauri::command]
pub async fn integrator_skills_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    repository: String,
) -> CommandResult<IntegratorSkillsOverview> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        let documents = documents_dir(&app).ok_or(CommandError {
            code: "unavailable",
            message: "could not locate the Documents folder".into(),
        })?;
        let plugins = plugins_root(&documents);
        fs::create_dir_all(&plugins).map_err(|error| CommandError {
            code: "unavailable",
            message: format!("could not prepare the Plugins folder: {error}"),
        })?;
        // Folder = `owner-name`: half the ecosystem's catalogs are literally
        // named `skills` (openai/skills, cloudflare/skills, …), so the bare
        // repository name would collide across labs.
        let folder = match repository.trim().split_once('/') {
            Some((owner, name))
                if !owner.is_empty()
                    && !name.is_empty()
                    && repository.trim().chars().all(|c| {
                        c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/')
                    }) =>
            {
                format!("{owner}-{name}")
            }
            _ => {
                return Err(CommandError {
                    code: "invalid-input",
                    message: "expected a GitHub repository like owner/name".into(),
                });
            }
        };
        let destination = plugins.join(&folder);
        if destination.exists() {
            return Err(CommandError {
                code: "invalid-input",
                message: format!(
                    "“{folder}” is already installed; remove it from the Plugins folder first"
                ),
            });
        }
        let github = GithubCliService::discover().ok_or(CommandError {
            code: "provider-unavailable",
            message: "GitHub CLI is not installed; install gh to add plugins".into(),
        })?;
        github
            .clone_repository(&repository, &destination)
            .map_err(CommandError::from)?;
        overview(&app, &store)
    })
    .await
    .map_err(|_| CommandError {
        code: "unavailable",
        message: "plugin install worker failed".into(),
    })?
}

/// Uninstall one exact top-level plugin directory. The renderer supplies only
/// the opaque folder id returned by discovery; the host re-resolves it under
/// the canonical Plugins root and refuses links or nested paths.
#[tauri::command]
pub async fn integrator_skills_uninstall(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    plugin_id: String,
) -> CommandResult<IntegratorSkillsOverview> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        let id = plugin_id.trim();
        if id.is_empty()
            || id.starts_with('.')
            || !id
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
        {
            return Err(CommandError {
                code: "invalid-input",
                message: "Unknown installed plugin.".into(),
            });
        }
        let documents = documents_dir(&app).ok_or(CommandError {
            code: "unavailable",
            message: "could not locate the Documents folder".into(),
        })?;
        let root = plugins_root(&documents);
        let target = root.join(id);
        let metadata = fs::symlink_metadata(&target).map_err(|_| CommandError {
            code: "not-found",
            message: "This plugin is no longer installed.".into(),
        })?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(CommandError {
                code: "unauthorized",
                message: "The selected plugin is not a removable plugin directory.".into(),
            });
        }
        let canonical_root = fs::canonicalize(&root).map_err(|_| CommandError {
            code: "unavailable",
            message: "The Plugins folder could not be verified.".into(),
        })?;
        let canonical_target = fs::canonicalize(&target).map_err(|_| CommandError {
            code: "not-found",
            message: "This plugin is no longer installed.".into(),
        })?;
        if canonical_target.parent() != Some(canonical_root.as_path()) {
            return Err(CommandError {
                code: "unauthorized",
                message: "The selected plugin is outside the Plugins folder.".into(),
            });
        }
        fs::remove_dir_all(&canonical_target).map_err(|error| CommandError {
            code: "unavailable",
            message: format!("Could not uninstall the plugin: {error}"),
        })?;

        let mut overrides = enabled_overrides(&store);
        let prefix = format!("{id}:");
        overrides.retain(|name, _| !name.starts_with(&prefix));
        store
            .set_setting(ENABLED_SETTING_KEY, Value::Object(overrides))
            .map_err(CommandError::from)?;
        overview(&app, &store)
    })
    .await
    .map_err(|_| CommandError {
        code: "unavailable",
        message: "plugin uninstall worker failed".into(),
    })?
}

/// Remove stale projection overlays. Called once at startup; overlays are
/// per-turn and the single-instance guard means none can be live here.
pub fn prune_projections(data_directory: &Path) {
    let root = data_directory.join(PROJECTION_DIR);
    if root.exists() {
        let _ = fs::remove_dir_all(root);
    }
}

/// The SKILL.md path for one entry (directory skills keep their metadata in
/// SKILL.md; bare `.md` skills are their own metadata).
fn skill_file(entry: &IntegratorSkillEntry) -> PathBuf {
    if entry.path.is_dir() {
        entry.path.join("SKILL.md")
    } else {
        entry.path.clone()
    }
}

/// A compact always-in-context index for runtimes without native skill
/// loading (Codex, Antigravity, ACP). One bounded line per enabled skill;
/// bodies and resources stay on disk until the agent reads them, preserving
/// progressive disclosure.
pub fn skill_index_block(skills: &[IntegratorSkillEntry]) -> Option<String> {
    if skills.is_empty() {
        return None;
    }
    let mut block = String::from(
        "<integrator-skills>\nThe user enabled these skills. When a request matches one, \
         read its SKILL.md file first and follow it. Invoke none of them otherwise.\n",
    );
    for entry in skills.iter().take(64) {
        let description = entry.description.chars().take(160).collect::<String>();
        block.push_str(&format!(
            "- {} — {} — {}\n",
            entry.name,
            description,
            skill_file(entry).to_string_lossy()
        ));
    }
    block.push_str("</integrator-skills>\n\n");
    Some(block)
}

/// The wire text for an explicit `/skill` invocation on a runtime that does
/// not load this skill natively: the bounded SKILL.md body plus the user's
/// arguments. The visible transcript keeps the exact `/name` the user typed.
pub fn skill_invocation_block(entry: &IntegratorSkillEntry, rest: &str) -> CommandResult<String> {
    let path = skill_file(entry);
    let metadata = fs::symlink_metadata(&path).map_err(|_| stale_skill())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 64 * 1024 {
        return Err(stale_skill());
    }
    let body = fs::read_to_string(&path).map_err(|_| stale_skill())?;
    let request = rest.trim();
    let request = if request.is_empty() {
        "Apply this skill to the current task."
    } else {
        request
    };
    Ok(format!(
        "The user explicitly invoked the skill \"{name}\". Follow its instructions for this \
         request. Supporting files live next to the skill at {dir}.\n<skill name=\"{name}\">\n\
         {body}\n</skill>\n\nUser request: {request}",
        name = entry.name,
        dir = entry.path.to_string_lossy(),
    ))
}

fn stale_skill() -> CommandError {
    CommandError {
        code: "stale-native-action",
        message: "This skill changed on disk; choose it again from the slash menu".into(),
    }
}

/// Resolve one enabled skill by its namespaced name.
pub fn enabled_skill_named(
    app: &tauri::AppHandle,
    store: &LocalStore,
    name: &str,
) -> Option<IntegratorSkillEntry> {
    enabled_skills(app, store)
        .into_iter()
        .find(|entry| entry.name == name)
}

/// Sources owned by the Integrator plane (vs a provider's own catalog).
pub fn is_integrator_source(source: &str) -> bool {
    matches!(source, "integrator" | "plugin" | "first-party")
}

/// One per-turn projection: the plugin bundle directories handed to the
/// runtime, plus the same skill entries remapped to their overlay copies
/// (used when the runtime's sandbox can only read the overlay).
pub struct SkillProjection {
    pub plugin_dirs: Vec<PathBuf>,
    pub entries: Vec<IntegratorSkillEntry>,
}

/// Materialize the enabled skills as plugin bundles inside an
/// Integrator-owned, per-turn overlay under app-data. Claude receives the
/// bundle directories via `--plugin-dir`; Antigravity receives them via
/// `--add-dir` with the remapped entries in its skill index. The overlay is
/// a copy, never a link: an edit mid-turn cannot split the guidance a
/// running turn already loaded.
pub fn write_projection(
    data_directory: &Path,
    provider: &str,
    skills: &[IntegratorSkillEntry],
) -> io::Result<SkillProjection> {
    if skills.is_empty() {
        return Ok(SkillProjection {
            plugin_dirs: Vec::new(),
            entries: Vec::new(),
        });
    }
    let overlay = data_directory
        .join(PROJECTION_DIR)
        .join(provider)
        .join(uuid::Uuid::new_v4().to_string());
    let mut plugin_dirs = Vec::new();
    let mut entries = Vec::new();
    for entry in skills {
        let Some((namespace, skill_name)) = entry.name.split_once(':') else {
            continue;
        };
        let plugin_dir = overlay.join(namespace);
        if !plugin_dirs.contains(&plugin_dir) {
            let manifest_dir = plugin_dir.join(".claude-plugin");
            fs::create_dir_all(&manifest_dir)?;
            let manifest = serde_json::json!({
                "name": namespace,
                "description": format!("AI Integrator projected skills ({namespace})"),
                "version": "0.0.0",
            });
            fs::write(
                manifest_dir.join("plugin.json"),
                serde_json::to_vec_pretty(&manifest).expect("static manifest"),
            )?;
            plugin_dirs.push(plugin_dir.clone());
        }
        let target = plugin_dir.join("skills").join(skill_name);
        if entry.path.is_dir() {
            copy_skill_dir(&entry.path, &target, 0, &mut 0)?;
        } else {
            fs::create_dir_all(&target)?;
            fs::copy(&entry.path, target.join("SKILL.md"))?;
        }
        entries.push(IntegratorSkillEntry {
            name: entry.name.clone(),
            description: entry.description.clone(),
            source: entry.source.clone(),
            path: target,
        });
    }
    Ok(SkillProjection {
        plugin_dirs,
        entries,
    })
}

fn copy_skill_dir(
    source: &Path,
    target: &Path,
    depth: usize,
    copied: &mut usize,
) -> io::Result<()> {
    if depth > MAX_PROJECTED_DEPTH {
        return Ok(());
    }
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)?.flatten() {
        if *copied >= MAX_PROJECTED_FILES {
            return Ok(());
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            copy_skill_dir(
                &entry.path(),
                &target.join(entry.file_name()),
                depth + 1,
                copied,
            )?;
        } else if kind.is_file() {
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.len() > MAX_PROJECTED_FILE_BYTES {
                continue;
            }
            fs::copy(entry.path(), target.join(entry.file_name()))?;
            *copied += 1;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_enable_user_skills_and_skill_creator_only() {
        assert!(default_enabled("integrator:fred"));
        assert!(default_enabled("integrator-authoring:skill-creator"));
        assert!(!default_enabled("gov-data:fred"));
        assert!(!default_enabled("integrator-authoring:plugin-packager"));
    }

    #[test]
    fn projection_copies_bounded_plugin_bundles_and_skips_symlinks() {
        let root = std::env::temp_dir().join(format!("skills-proj-{}", uuid::Uuid::new_v4()));
        let skill_dir = root.join("source").join("fred");
        fs::create_dir_all(&skill_dir).expect("fixture");
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: fred\ndescription: d\n---\nBODY",
        )
        .expect("skill file");
        fs::write(
            skill_dir.join("big.bin"),
            vec![0u8; (MAX_PROJECTED_FILE_BYTES + 1) as usize],
        )
        .expect("oversized file");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&root, skill_dir.join("loop")).expect("symlink fixture");

        let entries = vec![IntegratorSkillEntry {
            name: "gov-data:fred".into(),
            description: "d".into(),
            source: "plugin".into(),
            path: skill_dir,
        }];
        let data_dir = root.join("app-data");
        let projection = write_projection(&data_dir, "claude", &entries).expect("projection");
        let dirs = &projection.plugin_dirs;
        assert_eq!(dirs.len(), 1);
        assert!(dirs[0].ends_with("gov-data"));
        assert!(dirs[0].join(".claude-plugin").join("plugin.json").is_file());
        let projected = dirs[0].join("skills").join("fred");
        assert!(projected.join("SKILL.md").is_file());
        assert!(!projected.join("big.bin").exists());
        assert!(!projected.join("loop").exists());
        // Remapped entries point inside the overlay so a sandboxed runtime
        // granted the overlay can read them.
        assert_eq!(projection.entries.len(), 1);
        assert!(projection.entries[0].path.starts_with(&data_dir));
        prune_projections(&data_dir);
        assert!(!data_dir.join(PROJECTION_DIR).exists());
        fs::remove_dir_all(root).expect("clean up projection fixtures");
    }

    #[test]
    fn index_block_is_bounded_and_empty_for_no_skills() {
        assert!(skill_index_block(&[]).is_none());
        let entry = IntegratorSkillEntry {
            name: "gov-data:fred".into(),
            description: "x".repeat(500),
            source: "plugin".into(),
            path: PathBuf::from("/skills/fred"),
        };
        let block = skill_index_block(&[entry]).expect("index");
        assert!(block.contains("gov-data:fred"));
        // A path that is not a real directory on disk is indexed as-is.
        assert!(block.contains("/skills/fred"));
        // Descriptions are truncated so one skill cannot flood the index.
        assert!(block.len() < 600);
    }

    #[test]
    fn invocation_block_carries_body_and_rejects_oversized_or_missing_files() {
        let root = std::env::temp_dir().join(format!("skills-invoke-{}", uuid::Uuid::new_v4()));
        let skill_dir = root.join("fred");
        fs::create_dir_all(&skill_dir).expect("fixture");
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: fred\ndescription: d\n---\nFETCH THE SERIES",
        )
        .expect("skill file");
        let entry = IntegratorSkillEntry {
            name: "gov-data:fred".into(),
            description: "d".into(),
            source: "plugin".into(),
            path: skill_dir.clone(),
        };
        let block = skill_invocation_block(&entry, " CPIAUCSL last year").expect("invocation");
        assert!(block.contains("FETCH THE SERIES"));
        assert!(block.contains("User request: CPIAUCSL last year"));
        let empty = skill_invocation_block(&entry, "  ").expect("empty invocation");
        assert!(empty.contains("Apply this skill to the current task."));
        let missing = IntegratorSkillEntry {
            path: root.join("gone"),
            ..entry
        };
        assert!(skill_invocation_block(&missing, "").is_err());
        fs::write(skill_dir.join("SKILL.md"), "x".repeat(65 * 1024)).expect("oversize");
        let oversized = IntegratorSkillEntry {
            path: skill_dir,
            ..missing
        };
        assert!(skill_invocation_block(&oversized, "").is_err());
        fs::remove_dir_all(root).expect("clean up invocation fixtures");
    }
}
