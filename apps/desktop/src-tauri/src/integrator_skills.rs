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

use integrator_core::IntegratorError;
use integrator_runtime::GithubCliService;
use serde::Serialize;
use serde_json::Value;
use session_store::LocalStore;
use tauri::Manager;
use zeroize::Zeroizing;

use crate::command_api::{CommandError, CommandResult};
use crate::credential_store::{self, CredentialStorage};
use crate::native_actions::{IntegratorSkillEntry, discover_integrator_skills};
use crate::state::AppState;

/// Written by the renderer through the standard settings path
/// (`setSetting("skills.integrator.enabled", …)` prefixes `settings.`).
const ENABLED_SETTING_KEY: &str = "settings.skills.integrator.enabled";
const PRODUCTION_SKILL_CREDENTIAL_SERVICE: &str = "dev.aiintegrator.skill-credential.production.v1";
const DEVELOPMENT_SKILL_SECRET_PRESENCE_SETTING_KEY: &str =
    "settings.skills.secure-data.development.presence";
const PRODUCTION_SKILL_SECRET_PRESENCE_SETTING_KEY: &str =
    "settings.skills.secure-data.production.presence";
const PROJECTION_DIR: &str = "skills-projection";
const BUNDLED_PLUGINS_RESOURCE_DIR: &str = "first-party-plugins";
/// Per-skill copy bounds for the projection overlay. Oversized content is
/// skipped file-by-file so one huge reference file cannot block a skill.
const MAX_PROJECTED_FILES: usize = 64;
const MAX_PROJECTED_FILE_BYTES: u64 = 512 * 1024;
const MAX_PROJECTED_DEPTH: usize = 4;

pub fn skills_root(documents: &Path) -> PathBuf {
    documents.join("AI Integrator").join("Skills")
}

pub(crate) fn plugins_root(documents: &Path) -> PathBuf {
    documents.join("AI Integrator").join("Plugins")
}

pub(crate) fn documents_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
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
    fs::create_dir_all(crate::integrator_mcp::mcps_root(&documents))?;
    crate::diagnostic_log::ensure_logs_dir(&documents)?;
    Ok(())
}

/// First-party plugins bundled with the app. Release builds resolve the
/// bundled resource tree; dev builds fall back to the repository checkout so
/// `tauri dev` exercises the same catalog without a packaging step.
pub(crate) fn bundled_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join(BUNDLED_PLUGINS_RESOURCE_DIR);
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

fn select_installed_skills(
    installed: &[IntegratorSkillEntry],
    names: &[String],
) -> integrator_core::Result<Vec<IntegratorSkillEntry>> {
    let mut selected = Vec::with_capacity(names.len());
    for name in names {
        let entry = installed
            .iter()
            .find(|entry| entry.name == *name)
            .cloned()
            .ok_or_else(|| {
                IntegratorError::Unavailable(format!(
                    "assigned skill '{name}' is no longer installed; review the specialist before continuing"
                ))
            })?;
        selected.push(entry);
    }
    Ok(selected)
}

/// Resolve a specialist snapshot's exact skill identities against installed
/// inventory. Specialist assignment is its own explicit authority grant, so a
/// skill may remain off for ordinary orchestrator chats while being equipped
/// on this child. Uninstalled identities still fail closed.
pub fn selected_installed_skills(
    app: &tauri::AppHandle,
    names: &[String],
) -> integrator_core::Result<Vec<IntegratorSkillEntry>> {
    select_installed_skills(&discover_all(app), names)
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
    pub storage: CredentialStorage,
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

pub(crate) fn overview(
    app: &tauri::AppHandle,
    store: &LocalStore,
) -> CommandResult<IntegratorSkillsOverview> {
    let documents = documents_dir(app).ok_or(CommandError {
        code: "unavailable",
        message: "could not locate the Documents folder".into(),
    })?;
    let overrides = enabled_overrides(store);
    let credential_presence = credential_presence(store);
    let invocation_counts = store
        .skill_invocation_counts()
        .map_err(CommandError::from)?;
    let skills = discover_all(app)
        .into_iter()
        .map(|entry| {
            let credential = credential_definition(&entry)
                .map(|definition| credential_info(&credential_presence, definition));
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
    required: true,
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
    required: true,
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
        "market-data:alpha-vantage" => Some(ALPHA_VANTAGE_CREDENTIAL),
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

fn skill_secret_presence_setting_key() -> &'static str {
    match credential_store::storage() {
        CredentialStorage::ProtectedLocalFile => DEVELOPMENT_SKILL_SECRET_PRESENCE_SETTING_KEY,
        CredentialStorage::OsCredentialStore => PRODUCTION_SKILL_SECRET_PRESENCE_SETTING_KEY,
    }
}

fn credential_presence_at(store: &LocalStore, setting_key: &str) -> serde_json::Map<String, Value> {
    store
        .get_setting(setting_key)
        .ok()
        .flatten()
        .and_then(|setting| setting.value.as_object().cloned())
        .unwrap_or_default()
}

fn credential_presence(store: &LocalStore) -> serde_json::Map<String, Value> {
    credential_presence_at(store, skill_secret_presence_setting_key())
}

fn set_credential_presence_at(store: &LocalStore, setting_key: &str, id: &str, configured: bool) {
    let mut presence = credential_presence_at(store, setting_key);
    presence.insert(id.into(), Value::Bool(configured));
    let _ = store.set_setting(setting_key, Value::Object(presence));
}

fn set_credential_presence(store: &LocalStore, id: &str, configured: bool) {
    set_credential_presence_at(store, skill_secret_presence_setting_key(), id, configured);
}

fn credential_is_configured(store: &LocalStore, id: &str) -> bool {
    credential_presence(store)
        .get(id)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub(crate) fn skill_credential_secret(
    state: &AppState,
    id: &str,
    required: bool,
) -> integrator_core::Result<Option<Zeroizing<String>>> {
    let definition = credential_by_id(id)
        .ok_or_else(|| IntegratorError::InvalidInput("unknown skill credential".into()))?;
    if let Some(secret) = state.cached_skill_credential(definition.id)? {
        return Ok(Some(secret));
    }
    if !credential_is_configured(&state.store, definition.id) {
        return if required {
            Err(IntegratorError::InvalidInput(format!(
                "add the {} in AI Integrator Settings before using this skill",
                definition.label
            )))
        } else {
            Ok(None)
        };
    }
    let value = match credential_store::read(PRODUCTION_SKILL_CREDENTIAL_SERVICE, definition.id) {
        Ok(value) => value,
        Err(_) if !required => return Ok(None),
        Err(_) => {
            return Err(IntegratorError::Unavailable(
                "the native credential store could not be read".into(),
            ));
        }
    };
    if let Some(secret) = value {
        state.cache_skill_credential(definition.id, secret.clone())?;
        set_credential_presence(&state.store, definition.id, true);
        Ok(Some(secret))
    } else {
        set_credential_presence(&state.store, definition.id, false);
        if required {
            Err(IntegratorError::InvalidInput(format!(
                "add the {} in AI Integrator Settings before using this skill",
                definition.label
            )))
        } else {
            Ok(None)
        }
    }
}

fn credential_info(
    presence: &serde_json::Map<String, Value>,
    definition: SkillCredentialDefinition,
) -> IntegratorSkillCredentialInfo {
    let storage = credential_store::storage();
    let available = credential_store::available(PRODUCTION_SKILL_CREDENTIAL_SERVICE, definition.id);
    IntegratorSkillCredentialInfo {
        id: definition.id.into(),
        label: definition.label.into(),
        required: definition.required,
        configured: presence
            .get(definition.id)
            .and_then(Value::as_bool)
            .unwrap_or(false),
        available,
        storage,
        help_url: definition.help_url.into(),
    }
}

#[tauri::command]
pub fn integrator_skill_credential_set(
    state: tauri::State<'_, AppState>,
    credential_id: String,
    secret: String,
) -> CommandResult<()> {
    let secret = Zeroizing::new(secret);
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
    credential_store::write(PRODUCTION_SKILL_CREDENTIAL_SERVICE, definition.id, value).map_err(
        |_| CommandError {
            code: "credential-store-unavailable",
            message: format!(
                "The {} could not be saved to native credential storage.",
                definition.label
            ),
        },
    )?;
    state
        .cache_skill_credential(definition.id, Zeroizing::new(value.to_owned()))
        .map_err(CommandError::from)?;
    set_credential_presence(&state.store, definition.id, true);
    Ok(())
}

#[tauri::command]
pub fn integrator_skill_credential_clear(
    state: tauri::State<'_, AppState>,
    credential_id: String,
) -> CommandResult<()> {
    let id = credential_id.trim();
    let Some(definition) = credential_by_id(id) else {
        return Err(CommandError {
            code: "invalid-input",
            message: "Unknown skill credential.".into(),
        });
    };
    credential_store::delete(PRODUCTION_SKILL_CREDENTIAL_SERVICE, definition.id).map_err(|_| {
        CommandError {
            code: "credential-store-unavailable",
            message: format!(
                "The {} could not be removed from native credential storage.",
                definition.label
            ),
        }
    })?;
    state
        .forget_skill_credential(definition.id)
        .map_err(CommandError::from)?;
    set_credential_presence(&state.store, definition.id, false);
    Ok(())
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

/// Bounded read-only display of one local skill's SKILL.md, for the
/// explicit "view full prompt" action — never surfaced automatically, and
/// distinct from discovery/projection, which never expose skill bodies.
const MAX_SKILL_BODY_BYTES: u64 = 256 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegratorSkillBody {
    pub name: String,
    pub description: String,
    pub body: String,
    pub truncated: bool,
}

#[tauri::command]
pub async fn integrator_skill_body(
    app: tauri::AppHandle,
    name: String,
) -> CommandResult<IntegratorSkillBody> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = discover_all(&app)
            .into_iter()
            .find(|entry| entry.name == name)
            .ok_or_else(|| CommandError {
                code: "not-found",
                message: "This skill is no longer available.".into(),
            })?;
        let path = skill_file(&entry);
        let metadata = fs::symlink_metadata(&path).map_err(|_| CommandError {
            code: "not-found",
            message: "The skill file is unavailable.".into(),
        })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(CommandError {
                code: "not-found",
                message: "The skill file is unavailable.".into(),
            });
        }
        let content = fs::read_to_string(&path).map_err(|_| CommandError {
            code: "unavailable",
            message: "Could not read the skill file.".into(),
        })?;
        let truncated = metadata.len() > MAX_SKILL_BODY_BYTES;
        let body = if truncated {
            content
                .chars()
                .take(MAX_SKILL_BODY_BYTES as usize)
                .collect()
        } else {
            content
        };
        Ok(IntegratorSkillBody {
            name: entry.name,
            description: entry.description,
            body,
            truncated,
        })
    })
    .await
    .map_err(|_| CommandError {
        code: "unavailable",
        message: "skill body worker failed".into(),
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
        let documents = documents_dir(&app).ok_or(CommandError {
            code: "unavailable",
            message: "could not locate the Documents folder".into(),
        })?;
        let root = plugins_root(&documents);
        let canonical_target = resolve_uninstall_target(&root, id)?;
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

fn resolve_uninstall_target(root: &Path, id: &str) -> CommandResult<PathBuf> {
    if id.is_empty()
        || id.starts_with('.')
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(CommandError {
            code: "invalid-input",
            message: "Unknown installed plugin.".into(),
        });
    }
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
    let canonical_root = fs::canonicalize(root).map_err(|_| CommandError {
        code: "unavailable",
        message: "The Plugins folder could not be verified.".into(),
    })?;
    let canonical_target = fs::canonicalize(target).map_err(|_| CommandError {
        code: "not-found",
        message: "This plugin is no longer installed.".into(),
    })?;
    if canonical_target.parent() != Some(canonical_root.as_path()) {
        return Err(CommandError {
            code: "unauthorized",
            message: "The selected plugin is outside the Plugins folder.".into(),
        });
    }
    Ok(canonical_target)
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
    let guidance = skill_api_guidance(entry)
        .map(|value| format!("\n\nSecure data access: {value}"))
        .unwrap_or_default();
    Ok(format!(
        "The user explicitly invoked the skill \"{name}\". Follow its instructions for this \
         request. Supporting files live next to the skill at {dir}.\n<skill name=\"{name}\">\n\
         {body}\n</skill>{guidance}\n\nUser request: {request}",
        name = entry.name,
        dir = entry.path.to_string_lossy(),
    ))
}

fn skill_api_guidance(entry: &IntegratorSkillEntry) -> Option<String> {
    if entry.source != "first-party" {
        return None;
    }
    let example = match entry.name.as_str() {
        "gov-data:fred" => {
            r#"{"provider":"fred","path":"/fred/series/observations","query":{"series_id":"GDP","file_type":"json"}}"#
        }
        "gov-data:bls" => {
            r#"{"provider":"bls","body":{"seriesid":["LNS14000000"],"startyear":"2020","endyear":"2026"}}"#
        }
        "gov-data:census" => {
            r#"{"provider":"census","path":"/data/2023/acs/acs5","query":{"get":"NAME,B01003_001E","for":"state:*"}}"#
        }
        "gov-data:eia" => {
            r#"{"provider":"eia","path":"/v2/petroleum/pri/gnd/data/","query":{"frequency":"weekly","data[0]":"value"}}"#
        }
        "market-data:alpha-vantage" => {
            r#"{"provider":"alpha-vantage","query":{"function":"TIME_SERIES_DAILY","symbol":"AAPL","outputsize":"compact"}}"#
        }
        _ => return None,
    };
    Some(format!(
        "Call `skill_data_request` on the `integrator` MCP server with `{example}`. \
         The running native app reads the configured key from the OS credential store; \
         never request, print, or inspect environment variables for this credential."
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
        if let Some(guidance) = skill_api_guidance(entry) {
            use std::io::Write;
            let mut file = fs::OpenOptions::new()
                .append(true)
                .open(target.join("SKILL.md"))?;
            write!(
                file,
                "\n\n## AI Integrator secure data access\n\n{guidance}\n"
            )?;
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
    fn specialist_selection_resolves_installed_skills_independent_of_main_chat_enablement() {
        let installed = vec![IntegratorSkillEntry {
            name: "documents:pdf".into(),
            description: "Create and inspect PDFs".into(),
            source: "plugin".into(),
            path: PathBuf::from("/plugins/documents/skills/pdf"),
        }];
        let mut main_chat_overrides = serde_json::Map::new();
        main_chat_overrides.insert("documents:pdf".into(), Value::Bool(false));
        assert!(!is_enabled(&main_chat_overrides, "documents:pdf"));

        let selected = select_installed_skills(&installed, &["documents:pdf".into()])
            .expect("installed specialist skill");
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].name, "documents:pdf");

        let missing = select_installed_skills(&installed, &["documents:spreadsheets".into()])
            .expect_err("missing skills must fail closed");
        assert!(missing.to_string().contains("no longer installed"));
    }

    #[test]
    fn market_data_secret_authority_belongs_only_to_alpha_vantage() {
        let entry = |name: &str| IntegratorSkillEntry {
            name: name.into(),
            description: "d".into(),
            source: "first-party".into(),
            path: PathBuf::from("/skills/provider"),
        };
        assert_eq!(
            credential_definition(&entry("market-data:alpha-vantage"))
                .map(|definition| definition.id),
            Some(ALPHA_VANTAGE_CREDENTIAL.id)
        );
        assert!(credential_definition(&entry("market-data:stooq")).is_none());
        assert!(credential_definition(&entry("market-data:yfinance")).is_none());
        assert!(skill_api_guidance(&entry("market-data:stooq")).is_none());
        assert!(skill_api_guidance(&entry("market-data:yfinance")).is_none());
    }

    #[test]
    fn uninstall_target_is_one_real_top_level_directory() {
        let root = std::env::temp_dir().join(format!("skills-uninstall-{}", uuid::Uuid::new_v4()));
        let plugin = root.join("openai-skills");
        fs::create_dir_all(&plugin).expect("plugin fixture");
        assert_eq!(
            resolve_uninstall_target(&root, "openai-skills").expect("safe plugin"),
            fs::canonicalize(&plugin).expect("canonical plugin")
        );
        assert!(resolve_uninstall_target(&root, "../escape").is_err());
        assert!(resolve_uninstall_target(&root, ".hidden").is_err());
        #[cfg(unix)]
        {
            let outside = root.with_extension("outside");
            fs::create_dir_all(&outside).expect("outside fixture");
            std::os::unix::fs::symlink(&outside, root.join("linked-plugin"))
                .expect("plugin symlink fixture");
            assert!(resolve_uninstall_target(&root, "linked-plugin").is_err());
            fs::remove_dir_all(outside).expect("clean outside fixture");
        }
        fs::remove_dir_all(root).expect("clean uninstall fixtures");
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
    fn secure_data_tool_stays_out_of_the_automatic_skill_index() {
        let entry = IntegratorSkillEntry {
            name: "market-data:alpha-vantage".into(),
            description: "Fetch current market data".into(),
            source: "first-party".into(),
            path: PathBuf::from("/skills/alpha-vantage"),
        };
        let block = skill_index_block(&[entry]).expect("index");
        assert!(!block.contains("skill_data_request"));
        assert!(!block.contains("--skill-api"));
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

    #[test]
    fn explicit_first_party_invocation_includes_the_secure_data_tool() {
        let root = std::env::temp_dir().join(format!("skills-api-{}", uuid::Uuid::new_v4()));
        let skill_dir = root.join("alpha-vantage");
        fs::create_dir_all(&skill_dir).expect("fixture");
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: alpha-vantage\ndescription: d\n---\nFETCH MARKET DATA",
        )
        .expect("skill file");
        let entry = IntegratorSkillEntry {
            name: "market-data:alpha-vantage".into(),
            description: "d".into(),
            source: "first-party".into(),
            path: skill_dir,
        };
        let block = skill_invocation_block(&entry, "AAPL today").expect("invocation");
        assert!(block.contains("skill_data_request"));
        assert!(block.contains("\"provider\":\"alpha-vantage\""));
        fs::remove_dir_all(root).expect("clean up invocation fixtures");
    }

    #[test]
    fn credential_presence_is_non_secret_local_metadata() {
        let store = LocalStore::open_in_memory().expect("store");
        assert!(credential_presence(&store).is_empty());
        assert!(!credential_is_configured(&store, CENSUS_CREDENTIAL.id));

        set_credential_presence(&store, CENSUS_CREDENTIAL.id, true);
        assert_eq!(
            credential_presence(&store)
                .get(CENSUS_CREDENTIAL.id)
                .and_then(Value::as_bool),
            Some(true)
        );
        assert!(credential_is_configured(&store, CENSUS_CREDENTIAL.id));
        set_credential_presence(&store, CENSUS_CREDENTIAL.id, false);
        assert!(!credential_is_configured(&store, CENSUS_CREDENTIAL.id));
    }

    #[test]
    fn development_avoids_the_os_credential_store() {
        assert_eq!(
            credential_store::storage(),
            CredentialStorage::ProtectedLocalFile
        );
    }
}
