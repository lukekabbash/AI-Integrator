//! Integrator-plane MCP servers.
//!
//! Servers are user-owned JSON files under `Documents/AI Integrator/MCPs/`
//! (one file per server, hand-editable) plus `mcp.json` bundles inside
//! installed and first-party plugins. Enablement is opt-in for every server
//! regardless of origin — an MCP server is a process with credentials, not
//! a markdown file. Projection targets Claude's `--mcp-config`; other
//! runtimes bind servers at session start and are labeled honestly in the UI.

use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use adapter_acp::AcpSessionCapabilities;
use serde::Serialize;
use serde_json::Value;
use session_store::LocalStore;
use zeroize::Zeroizing;

use crate::commands::{CommandError, CommandResult};
use crate::credential_store::{self, CredentialStorage};
use crate::integrator_skills::{bundled_root, documents_dir, plugins_root};
use crate::mcp_oauth::McpAuthorization;
use crate::state::AppState;

pub const ENABLED_SETTING_KEY: &str = "settings.mcp.integrator.enabled";
pub const REVISION_SETTING_KEY: &str = "settings.mcp.integrator.revision";
const MCP_CREDENTIAL_SERVICE: &str = "dev.aiintegrator.mcp-credential";
/// Env values set to this placeholder never live in the JSON file; the
/// secret is stored in the OS credential store and resolved at projection.
const KEYCHAIN_PLACEHOLDER: &str = "{{keychain}}";
const PROJECTION_DIR: &str = "mcp-projection";
const MAX_FILE_BYTES: u64 = 64 * 1024;
const MAX_SERVERS: usize = 128;
const MAX_ARGS: usize = 32;
const MAX_ENV: usize = 32;
const MAX_TEXT: usize = 2_048;

fn is_false(value: &bool) -> bool {
    !*value
}

fn known_oauth_server(url: &str) -> bool {
    matches!(
        url.trim_end_matches('/'),
        "https://mcp.vercel.com"
            | "https://mcp.supabase.com/mcp"
            | "https://mcp.stripe.com"
            | "https://huggingface.co/mcp"
            | "https://api.githubcopilot.com/mcp"
            | "https://mcp.notion.com/mcp"
            | "https://mcp.linear.app/mcp"
            | "https://mcp.figma.com/mcp"
            | "https://mcp.sentry.dev/mcp"
    )
}

pub fn mcps_root(documents: &Path) -> PathBuf {
    documents.join("AI Integrator").join("MCPs")
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "transport")]
pub enum McpTransport {
    #[serde(rename_all = "camelCase")]
    Stdio {
        command: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
    },
    #[serde(rename_all = "camelCase")]
    Remote {
        url: String,
        #[serde(default, skip_serializing_if = "is_false")]
        oauth: bool,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCredentialSlot {
    /// The env key whose value is `{{keychain}}` in the server file.
    pub key: String,
    pub configured: bool,
    pub available: bool,
    pub storage: CredentialStorage,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegratorMcpServer {
    /// Namespaced for plugin servers (`stripe-ai:stripe`), bare for user files.
    pub name: String,
    /// "user" | "plugin" | "first-party".
    pub source: String,
    /// Display origin: the plugin folder name, or "MCPs folder" for user files.
    pub origin: String,
    pub enabled: bool,
    /// Keychain-backed env slots surfaced for a connect UI in Settings.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub credentials: Vec<McpCredentialSlot>,
    /// OAuth state for remote HTTP servers. Tokens never cross into the renderer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorization: Option<McpAuthorization>,
    #[serde(flatten)]
    pub transport: McpTransport,
}

fn credential_slots(name: &str, transport: &McpTransport) -> Vec<McpCredentialSlot> {
    let McpTransport::Stdio { env, .. } = transport else {
        return Vec::new();
    };
    env.iter()
        .filter(|(_, value)| value.as_str() == KEYCHAIN_PLACEHOLDER)
        .map(|(key, _)| {
            let account = format!("{name}/{key}");
            let status = credential_store::read(MCP_CREDENTIAL_SERVICE, &account)
                .map(|value| value.is_some());
            McpCredentialSlot {
                key: key.clone(),
                configured: status.as_ref().copied().unwrap_or(false),
                available: status.is_ok(),
                storage: credential_store::storage(),
            }
        })
        .collect()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegratorMcpOverview {
    pub mcps_root: String,
    pub servers: Vec<IntegratorMcpServer>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegratorMcpImportResult {
    pub imported: Vec<String>,
    pub skipped: Vec<String>,
    pub overview: IntegratorMcpOverview,
}

fn invalid(message: impl Into<String>) -> CommandError {
    CommandError {
        code: "invalid-input",
        message: message.into(),
    }
}

fn bounded_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return None;
    }
    Some(trimmed.to_owned())
}

fn valid_server_identity(value: &str) -> bool {
    bounded_name(value).is_some()
        || value.split_once(':').is_some_and(|(plugin, server)| {
            bounded_name(plugin).is_some() && bounded_name(server).is_some()
        })
}

/// Parse one server spec object: `{command, args?, env?}` or `{url}`.
/// Rejects rather than repairs — a config that cannot be represented exactly
/// must not silently launch something else.
fn parse_transport(spec: &Value) -> Result<McpTransport, String> {
    let object = spec.as_object().ok_or("server spec must be an object")?;
    if let Some(url) = object.get("url") {
        let url = url.as_str().ok_or("url must be a string")?.trim();
        if !(url.starts_with("https://") || url.starts_with("http://")) || url.len() > MAX_TEXT {
            return Err("url must be an http(s) URL".into());
        }
        let oauth = object.get("auth").and_then(Value::as_str) == Some("oauth")
            || object
                .get("oauth")
                .is_some_and(|value| value.as_bool() == Some(true) || value.is_object())
            || known_oauth_server(url);
        return Ok(McpTransport::Remote {
            url: url.into(),
            oauth,
        });
    }
    let command = object
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= MAX_TEXT)
        .ok_or("command must be a non-empty string")?;
    let mut args = Vec::new();
    if let Some(raw) = object.get("args") {
        for arg in raw.as_array().ok_or("args must be an array")?.iter() {
            let arg = arg.as_str().ok_or("args must be strings")?;
            if arg.len() > MAX_TEXT || args.len() >= MAX_ARGS {
                return Err("too many or oversized args".into());
            }
            args.push(arg.to_owned());
        }
    }
    let mut env = BTreeMap::new();
    if let Some(raw) = object.get("env") {
        for (key, value) in raw.as_object().ok_or("env must be an object")?.iter() {
            let value = value.as_str().ok_or("env values must be strings")?;
            if key.len() > 64
                || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                || value.len() > MAX_TEXT
                || env.len() >= MAX_ENV
            {
                return Err("invalid env entry".into());
            }
            env.insert(key.clone(), value.to_owned());
        }
    }
    Ok(McpTransport::Stdio {
        command: command.into(),
        args,
        env,
    })
}

/// Read one user server file: a bare spec (file stem = name) or a standard
/// `{"mcpServers": {name: spec}}` block pasted from another tool.
fn read_server_file(path: &Path, output: &mut Vec<(String, McpTransport)>) {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_FILE_BYTES {
        return;
    }
    let Ok(parsed) = fs::read_to_string(path)
        .map_err(|_| ())
        .and_then(|content| serde_json::from_str::<Value>(&content).map_err(|_| ()))
    else {
        return;
    };
    if let Some(servers) = parsed.get("mcpServers").and_then(Value::as_object) {
        for (key, spec) in servers.iter().take(16) {
            if let (Some(name), Ok(transport)) = (bounded_name(key), parse_transport(spec)) {
                output.push((name, transport));
            }
        }
        return;
    }
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    if let (Some(name), Ok(transport)) = (bounded_name(&stem), parse_transport(&parsed)) {
        output.push((name, transport));
    }
}

fn scan_user_root(root: &Path, output: &mut Vec<IntegratorMcpServer>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten().take(MAX_SERVERS) {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let mut found = Vec::new();
        read_server_file(&path, &mut found);
        for (name, transport) in found {
            output.push(IntegratorMcpServer {
                name,
                source: "user".into(),
                origin: "MCPs folder".into(),
                enabled: false,
                credentials: Vec::new(),
                authorization: None,
                transport,
            });
        }
    }
}

/// `mcp.json` / `.mcp.json` at a plugin's root declares its bundled servers,
/// namespaced by the plugin folder like plugin skills are.
fn scan_plugin_root(root: &Path, source: &str, output: &mut Vec<IntegratorMcpServer>) {
    let Ok(plugins) = fs::read_dir(root) else {
        return;
    };
    for plugin in plugins.flatten().take(256) {
        let Ok(kind) = plugin.file_type() else {
            continue;
        };
        if !kind.is_dir() || kind.is_symlink() {
            continue;
        }
        let Some(plugin_name) = bounded_name(&plugin.file_name().to_string_lossy()) else {
            continue;
        };
        for manifest in ["mcp.json", ".mcp.json"] {
            let mut found = Vec::new();
            read_server_file(&plugin.path().join(manifest), &mut found);
            for (name, transport) in found {
                output.push(IntegratorMcpServer {
                    name: format!("{plugin_name}:{name}"),
                    source: source.into(),
                    origin: plugin_name.clone(),
                    enabled: false,
                    credentials: Vec::new(),
                    authorization: None,
                    transport,
                });
            }
        }
    }
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

fn discover_all(app: &tauri::AppHandle, store: &LocalStore) -> Vec<IntegratorMcpServer> {
    let Some(documents) = documents_dir(app) else {
        return Vec::new();
    };
    let mut servers = Vec::new();
    scan_user_root(&mcps_root(&documents), &mut servers);
    scan_plugin_root(&plugins_root(&documents), "plugin", &mut servers);
    if let Some(bundled) = bundled_root(app) {
        scan_plugin_root(&bundled, "first-party", &mut servers);
    }
    let overrides = enabled_overrides(store);
    let mut seen = std::collections::HashSet::new();
    servers.retain(|server| seen.insert(server.name.clone()));
    servers.truncate(MAX_SERVERS);
    for server in &mut servers {
        // Every server defaults OFF: enabling a process is always explicit.
        server.enabled = overrides
            .get(&server.name)
            .and_then(Value::as_bool)
            .unwrap_or(false);
        server.credentials = credential_slots(&server.name, &server.transport);
        server.authorization = matches!(server.transport, McpTransport::Remote { oauth: true, .. })
            .then(|| crate::mcp_oauth::authorization_status(&server.name));
    }
    servers
}

pub fn enabled_servers(app: &tauri::AppHandle, store: &LocalStore) -> Vec<IntegratorMcpServer> {
    discover_all(app, store)
        .into_iter()
        .filter(|server| server.enabled)
        .collect()
}

/// Resolve only the MCP servers named by a delegation snapshot. Globally
/// disabling or removing one revokes future launches/resumes for that child.
pub fn selected_enabled_servers(
    app: &tauri::AppHandle,
    store: &LocalStore,
    names: &[String],
) -> integrator_core::Result<Vec<IntegratorMcpServer>> {
    let enabled = enabled_servers(app, store);
    let mut selected = Vec::with_capacity(names.len());
    for name in names {
        let server = enabled
            .iter()
            .find(|server| server.name == *name)
            .cloned()
            .ok_or_else(|| {
                integrator_core::IntegratorError::Unavailable(format!(
                    "assigned MCP server '{name}' is missing or disabled; review the specialist before continuing"
                ))
            })?;
        selected.push(server);
    }
    Ok(selected)
}

pub fn mark_configuration_changed(store: &LocalStore) -> integrator_core::Result<()> {
    store
        .set_setting(
            REVISION_SETTING_KEY,
            Value::String(uuid::Uuid::new_v4().to_string()),
        )
        .map(|_| ())
}

pub fn ensure_configuration_revision(store: &LocalStore) -> integrator_core::Result<()> {
    if store.get_setting(REVISION_SETTING_KEY)?.is_some() {
        return Ok(());
    }
    let has_enabled_server = store
        .get_setting(ENABLED_SETTING_KEY)?
        .and_then(|setting| setting.value.as_object().cloned())
        .is_some_and(|enabled| enabled.values().any(|value| value.as_bool() == Some(true)));
    if has_enabled_server {
        mark_configuration_changed(store)?;
    }
    Ok(())
}

pub fn resume_state_is_current(
    store: &LocalStore,
    state: &integrator_core::ProviderResumeState,
) -> bool {
    store
        .get_setting(REVISION_SETTING_KEY)
        .ok()
        .flatten()
        .is_none_or(|revision| state.updated_at >= revision.updated_at)
}

pub(crate) fn overview(
    app: &tauri::AppHandle,
    store: &LocalStore,
) -> CommandResult<IntegratorMcpOverview> {
    let documents = documents_dir(app).ok_or(CommandError {
        code: "unavailable",
        message: "could not locate the Documents folder".into(),
    })?;
    Ok(IntegratorMcpOverview {
        mcps_root: mcps_root(&documents).to_string_lossy().into_owned(),
        servers: discover_all(app, store),
    })
}

#[tauri::command]
pub async fn integrator_mcp_overview(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> CommandResult<IntegratorMcpOverview> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || overview(&app, &store))
        .await
        .map_err(|_| CommandError {
            code: "unavailable",
            message: "MCP discovery worker failed".into(),
        })?
}

/// Persist one user server file from the Settings form (or a curated
/// quick-add). Overwrites only files in the user's own MCPs folder.
#[tauri::command]
pub async fn integrator_mcp_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    name: String,
    config: Value,
) -> CommandResult<IntegratorMcpOverview> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        let name = bounded_name(&name).ok_or_else(|| {
            invalid("server names use letters, numbers, hyphens, underscores, and dots")
        })?;
        let transport = parse_transport(&config).map_err(invalid)?;
        let documents = documents_dir(&app).ok_or(CommandError {
            code: "unavailable",
            message: "could not locate the Documents folder".into(),
        })?;
        let root = mcps_root(&documents);
        fs::create_dir_all(&root).map_err(|error| CommandError {
            code: "unavailable",
            message: format!("could not prepare the MCPs folder: {error}"),
        })?;
        let body = match &transport {
            McpTransport::Stdio { command, args, env } => serde_json::json!({
                "command": command,
                "args": args,
                "env": env,
            }),
            McpTransport::Remote { url, oauth } => {
                let mut body = serde_json::json!({ "url": url });
                if *oauth {
                    body["auth"] = Value::String("oauth".into());
                }
                body
            }
        };
        fs::write(
            root.join(format!("{name}.json")),
            serde_json::to_vec_pretty(&body).expect("static config"),
        )
        .map_err(|error| CommandError {
            code: "unavailable",
            message: format!("could not write the server file: {error}"),
        })?;
        mark_configuration_changed(&store).map_err(CommandError::from)?;
        overview(&app, &store)
    })
    .await
    .map_err(|_| CommandError {
        code: "unavailable",
        message: "MCP save worker failed".into(),
    })?
}

#[tauri::command]
pub async fn integrator_mcp_remove(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    name: String,
) -> CommandResult<IntegratorMcpOverview> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        let name = bounded_name(&name).ok_or_else(|| invalid("unknown server name"))?;
        let documents = documents_dir(&app).ok_or(CommandError {
            code: "unavailable",
            message: "could not locate the Documents folder".into(),
        })?;
        let path = mcps_root(&documents).join(format!("{name}.json"));
        if !path.is_file() {
            return Err(invalid(
                "only servers in your MCPs folder can be removed here; plugin servers go away with their plugin",
            ));
        }
        fs::remove_file(&path).map_err(|error| CommandError {
            code: "unavailable",
            message: format!("could not remove the server file: {error}"),
        })?;
        mark_configuration_changed(&store).map_err(CommandError::from)?;
        overview(&app, &store)
    })
    .await
    .map_err(|_| CommandError {
        code: "unavailable",
        message: "MCP remove worker failed".into(),
    })?
}

/// Copy servers already configured for Claude Code, Cursor, or Claude
/// Desktop into the user's MCPs folder. Vendor stores are read, never
/// written; existing files are never overwritten.
#[tauri::command]
pub async fn integrator_mcp_import(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> CommandResult<IntegratorMcpImportResult> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        let documents = documents_dir(&app).ok_or(CommandError {
            code: "unavailable",
            message: "could not locate the Documents folder".into(),
        })?;
        let root = mcps_root(&documents);
        fs::create_dir_all(&root).map_err(|error| CommandError {
            code: "unavailable",
            message: format!("could not prepare the MCPs folder: {error}"),
        })?;
        let mut imported = Vec::new();
        let mut skipped = Vec::new();
        for source in import_sources(&app) {
            let mut found = Vec::new();
            read_server_file(&source, &mut found);
            for (name, transport) in found {
                let target = root.join(format!("{name}.json"));
                if target.exists() {
                    skipped.push(name);
                    continue;
                }
                let body = match &transport {
                    McpTransport::Stdio { command, args, env } => serde_json::json!({
                        "command": command,
                        "args": args,
                        "env": env,
                    }),
                    McpTransport::Remote { url, oauth } => {
                        let mut body = serde_json::json!({ "url": url });
                        if *oauth {
                            body["auth"] = Value::String("oauth".into());
                        }
                        body
                    }
                };
                if fs::write(
                    &target,
                    serde_json::to_vec_pretty(&body).expect("static config"),
                )
                .is_ok()
                {
                    imported.push(name);
                }
            }
        }
        mark_configuration_changed(&store).map_err(CommandError::from)?;
        Ok(IntegratorMcpImportResult {
            imported,
            skipped,
            overview: overview(&app, &store)?,
        })
    })
    .await
    .map_err(|_| CommandError {
        code: "unavailable",
        message: "MCP import worker failed".into(),
    })?
}

fn import_sources(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut sources = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        sources.push(home.join(".claude.json"));
        sources.push(home.join(".cursor").join("mcp.json"));
        sources.push(
            home.join("Library")
                .join("Application Support")
                .join("Claude")
                .join("claude_desktop_config.json"),
        );
    }
    let _ = app;
    sources
}

/// Store one native-only env secret for a server. The JSON file keeps only
/// the `{{keychain}}` placeholder; the raw value never enters server config.
#[tauri::command]
pub fn integrator_mcp_credential_set(
    state: tauri::State<'_, AppState>,
    server: String,
    key: String,
    secret: String,
) -> CommandResult<()> {
    let secret = Zeroizing::new(secret);
    if !valid_server_identity(&server) {
        return Err(invalid("unknown server name"));
    }
    if key.len() > 64 || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(invalid("unknown credential key"));
    }
    let value = secret.trim();
    if value.is_empty() || value.chars().count() > 4_096 {
        return Err(invalid("paste a valid secret before saving"));
    }
    credential_store::write(MCP_CREDENTIAL_SERVICE, &format!("{server}/{key}"), value).map_err(
        |_| CommandError {
            code: "credential-store-unavailable",
            message: "Native credential storage could not be written.".into(),
        },
    )?;
    mark_configuration_changed(&state.store).map_err(CommandError::from)
}

#[tauri::command]
pub fn integrator_mcp_credential_clear(
    state: tauri::State<'_, AppState>,
    server: String,
    key: String,
) -> CommandResult<()> {
    if !valid_server_identity(&server) {
        return Err(invalid("unknown server name"));
    }
    if key.len() > 64 || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(invalid("unknown credential key"));
    }
    credential_store::delete(MCP_CREDENTIAL_SERVICE, &format!("{server}/{key}")).map_err(|_| {
        CommandError {
            code: "credential-store-unavailable",
            message: "Native credential storage could not be updated.".into(),
        }
    })?;
    mark_configuration_changed(&state.store).map_err(CommandError::from)
}

/// Complete a standards-based OAuth 2.1 + PKCE flow for one discovered remote
/// MCP server. Browser interaction remains user-owned; tokens are stored only
/// in the OS credential store and the renderer receives refreshed metadata.
#[tauri::command]
pub async fn integrator_mcp_oauth_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    server: String,
) -> CommandResult<IntegratorMcpOverview> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_server_identity(&server) {
            return Err(invalid("unknown server name"));
        }
        let discovered = discover_all(&app, &store)
            .into_iter()
            .find(|candidate| candidate.name == server)
            .ok_or_else(|| invalid("unknown server name"))?;
        let McpTransport::Remote { url, oauth: true } = discovered.transport else {
            return Err(invalid(
                "this remote MCP server is not configured for browser sign-in",
            ));
        };
        crate::mcp_oauth::connect(&server, &url)?;
        mark_configuration_changed(&store).map_err(CommandError::from)?;
        overview(&app, &store)
    })
    .await
    .map_err(|_| CommandError {
        code: "unavailable",
        message: "MCP sign-in worker failed".into(),
    })?
}

/// Revoke when the provider offers a revocation endpoint, then always remove
/// the local credential. Server configuration and enablement remain intact.
#[tauri::command]
pub async fn integrator_mcp_oauth_disconnect(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    server: String,
) -> CommandResult<IntegratorMcpOverview> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_server_identity(&server) {
            return Err(invalid("unknown server name"));
        }
        let remote = discover_all(&app, &store).into_iter().any(|candidate| {
            candidate.name == server
                && matches!(
                    candidate.transport,
                    McpTransport::Remote { oauth: true, .. }
                )
        });
        if !remote {
            return Err(invalid(
                "only discovered remote MCP servers can be disconnected",
            ));
        }
        crate::mcp_oauth::disconnect(&server)?;
        mark_configuration_changed(&store).map_err(CommandError::from)?;
        overview(&app, &store)
    })
    .await
    .map_err(|_| CommandError {
        code: "unavailable",
        message: "MCP disconnect worker failed".into(),
    })?
}

/// Remove stale per-turn MCP config overlays. Called once at startup.
pub fn prune_projections(data_directory: &Path) {
    let root = data_directory.join(PROJECTION_DIR);
    if root.exists() {
        let _ = fs::remove_dir_all(root);
    }
}

fn projection_name(name: &str) -> String {
    let mut projected = String::from("integrator_mcp_");
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() {
            projected.push(char::from(byte));
        } else {
            projected.push('_');
            projected.push_str(&format!("{byte:02x}"));
        }
    }
    projected
}

fn resolved_env(server: &str, env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    env.iter()
        .filter_map(|(key, value)| {
            if value != KEYCHAIN_PLACEHOLDER {
                return Some((key.clone(), value.clone()));
            }
            credential_store::read(MCP_CREDENTIAL_SERVICE, &format!("{server}/{key}"))
                .ok()
                .flatten()
                .map(|secret| (key.clone(), secret.to_string()))
        })
        .collect()
}

fn ensure_private_directory(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn write_private_json(path: &Path, value: &Value) -> io::Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "MCP projection path is not a regular file",
            ));
        }
        fs::remove_file(path)?;
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path)?;
    file.write_all(&serde_json::to_vec_pretty(value).expect("MCP projection serializes"))?;
    file.sync_all()
}

fn remote_headers(server: &str) -> serde_json::Map<String, Value> {
    crate::mcp_oauth::authorization_header(server)
        .map(|authorization| {
            serde_json::Map::from_iter([("Authorization".into(), Value::String(authorization))])
        })
        .unwrap_or_default()
}

fn claude_server_config_with_headers(
    server: &IntegratorMcpServer,
    headers: serde_json::Map<String, Value>,
) -> Value {
    match &server.transport {
        McpTransport::Stdio { command, args, env } => serde_json::json!({
            "command": command,
            "args": args,
            "env": resolved_env(&server.name, env),
        }),
        McpTransport::Remote { url, .. } => {
            let mut config = serde_json::json!({
                "type": "http",
                "url": url,
            });
            if !headers.is_empty() {
                config["headers"] = Value::Object(headers);
            }
            config
        }
    }
}

fn claude_server_config(server: &IntegratorMcpServer) -> Value {
    claude_server_config_with_headers(server, remote_headers(&server.name))
}

fn codex_server_config_with_headers(
    server: &IntegratorMcpServer,
    headers: serde_json::Map<String, Value>,
) -> Value {
    match &server.transport {
        McpTransport::Stdio { command, args, env } => serde_json::json!({
            "command": command,
            "args": args,
            "env": resolved_env(&server.name, env),
        }),
        McpTransport::Remote { url, .. } => {
            let mut config = serde_json::json!({ "url": url });
            if !headers.is_empty() {
                config["http_headers"] = Value::Object(headers);
            }
            config
        }
    }
}

fn codex_server_config(server: &IntegratorMcpServer) -> Value {
    codex_server_config_with_headers(server, remote_headers(&server.name))
}

pub fn merge_codex_mcp_config(mut base: Value, servers: &[IntegratorMcpServer]) -> Value {
    if !base.is_object() {
        base = serde_json::json!({});
    }
    let map = base
        .as_object_mut()
        .expect("Codex config is an object")
        .entry("mcp_servers")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if !map.is_object() {
        *map = Value::Object(serde_json::Map::new());
    }
    let map = map.as_object_mut().expect("mcp_servers is an object");
    for server in servers {
        map.insert(projection_name(&server.name), codex_server_config(server));
    }
    base
}

pub fn acp_mcp_server_entries(
    servers: &[IntegratorMcpServer],
    capabilities: AcpSessionCapabilities,
    cwd: &Path,
) -> CommandResult<Vec<Value>> {
    servers
        .iter()
        .map(|server| {
            let name = projection_name(&server.name);
            match &server.transport {
                McpTransport::Stdio { command, args, env } => {
                    let executable =
                        which::which_in(command, std::env::var_os("PATH"), cwd).map_err(|_| {
                            CommandError {
                                code: "provider-unavailable",
                                message: format!(
                                    "MCP server \"{}\" cannot start because command \"{command}\" was not found",
                                    server.name
                                ),
                            }
                        })?;
                    let env = resolved_env(&server.name, env)
                        .into_iter()
                        .map(|(name, value)| serde_json::json!({ "name": name, "value": value }))
                        .collect::<Vec<_>>();
                    Ok(serde_json::json!({
                        "name": name,
                        "command": executable.to_string_lossy(),
                        "args": args,
                        "env": env,
                    }))
                }
                McpTransport::Remote { url, .. } if capabilities.mcp_http => {
                    let headers = remote_headers(&server.name)
                        .into_iter()
                        .map(|(name, value)| {
                            serde_json::json!({
                                "name": name,
                                "value": value.as_str().unwrap_or_default(),
                            })
                        })
                        .collect::<Vec<_>>();
                    Ok(serde_json::json!({
                        "type": "http",
                        "name": name,
                        "url": url,
                        "headers": headers,
                    }))
                }
                McpTransport::Remote { .. } => Err(CommandError {
                    code: "provider-unavailable",
                    message: format!(
                        "This provider does not advertise ACP HTTP MCP support, so it cannot connect to \"{}\"",
                        server.name
                    ),
                }),
            }
        })
        .collect()
}

/// Write the enabled servers as a Claude `--mcp-config` file, merging with a
/// base config (the delegation broker's) when one exists so both surfaces
/// ride a single flag. Returns None when there is nothing to project.
pub fn write_claude_mcp_config(
    data_directory: &Path,
    servers: &[IntegratorMcpServer],
    base_config: Option<&Path>,
) -> io::Result<Option<PathBuf>> {
    if servers.is_empty() {
        return Ok(base_config.map(Path::to_path_buf));
    }
    let mut merged = match base_config {
        Some(path) => serde_json::from_str::<Value>(&fs::read_to_string(path)?)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?,
        None => serde_json::json!({}),
    };
    if !merged.is_object() {
        merged = serde_json::json!({});
    }
    let map = merged
        .as_object_mut()
        .expect("merged config is an object")
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if !map.is_object() {
        *map = Value::Object(serde_json::Map::new());
    }
    let map = map.as_object_mut().expect("mcpServers is an object");
    for server in servers {
        map.insert(projection_name(&server.name), claude_server_config(server));
    }
    let dir = data_directory.join(PROJECTION_DIR);
    ensure_private_directory(&dir)?;
    let path = dir.join(format!("{}.json", uuid::Uuid::new_v4()));
    write_private_json(&path, &merged)?;
    Ok(Some(path))
}

/// Antigravity discovers workspace customizations from every `--add-dir`
/// root. Its Integrator-owned control overlay therefore carries the enabled
/// MCP set without touching the repository or the user's global Gemini data.
#[cfg(test)]
pub fn write_antigravity_mcp_config(
    overlay_root: &Path,
    servers: &[IntegratorMcpServer],
) -> io::Result<Option<PathBuf>> {
    write_antigravity_mcp_config_with_base(overlay_root, servers, None)
}

/// Merge selected servers with an optional Integrator broker config so
/// Antigravity children get the same reporting channel as every other child.
pub fn write_antigravity_mcp_config_with_base(
    overlay_root: &Path,
    servers: &[IntegratorMcpServer],
    base_config: Option<&Path>,
) -> io::Result<Option<PathBuf>> {
    let agents = overlay_root.join(".agents");
    ensure_private_directory(&agents)?;
    let path = agents.join("mcp_config.json");
    if servers.is_empty() && base_config.is_none() {
        if let Err(error) = fs::remove_file(&path)
            && error.kind() != io::ErrorKind::NotFound
        {
            return Err(error);
        }
        return Ok(None);
    }
    let mut document = match base_config {
        Some(path) => serde_json::from_str::<Value>(&fs::read_to_string(path)?)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?,
        None => serde_json::json!({}),
    };
    if !document.is_object() {
        document = serde_json::json!({});
    }
    let selected = servers
        .iter()
        .map(|server| {
            let config = match &server.transport {
                McpTransport::Stdio { command, args, env } => serde_json::json!({
                    "command": command,
                    "args": args,
                    "env": resolved_env(&server.name, env),
                }),
                McpTransport::Remote { url, .. } => serde_json::json!({
                    "serverUrl": url,
                    "transport": "http",
                    "headers": remote_headers(&server.name),
                }),
            };
            (projection_name(&server.name), config)
        })
        .collect::<serde_json::Map<_, _>>();
    let mcp_servers = document
        .as_object_mut()
        .expect("Antigravity MCP config is an object")
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if !mcp_servers.is_object() {
        *mcp_servers = Value::Object(serde_json::Map::new());
    }
    mcp_servers
        .as_object_mut()
        .expect("mcpServers is an object")
        .extend(selected);
    write_private_json(&path, &document)?;
    Ok(Some(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_parsing_rejects_malformed_and_oversized_specs() {
        assert!(
            parse_transport(&serde_json::json!({ "command": "npx", "args": ["-y", "x"] })).is_ok()
        );
        assert!(parse_transport(&serde_json::json!({ "url": "https://example.com/mcp" })).is_ok());
        assert!(matches!(
            parse_transport(
                &serde_json::json!({ "url": "https://example.com/mcp", "auth": "oauth" })
            ),
            Ok(McpTransport::Remote { oauth: true, .. })
        ));
        assert!(matches!(
            parse_transport(&serde_json::json!({ "url": "https://mcp.figma.com/mcp" })),
            Ok(McpTransport::Remote { oauth: true, .. })
        ));
        assert!(matches!(
            parse_transport(&serde_json::json!({ "url": "https://docs.mcp.cloudflare.com/mcp" })),
            Ok(McpTransport::Remote { oauth: false, .. })
        ));
        assert!(parse_transport(&serde_json::json!({ "url": "ftp://example.com" })).is_err());
        assert!(parse_transport(&serde_json::json!({ "command": "" })).is_err());
        assert!(
            parse_transport(&serde_json::json!({ "command": "x", "args": "not-array" })).is_err()
        );
        assert!(
            parse_transport(&serde_json::json!({ "command": "x", "env": { "BAD KEY": "v" } }))
                .is_err()
        );
        let oversized_args = (0..MAX_ARGS + 1).map(|i| i.to_string()).collect::<Vec<_>>();
        assert!(
            parse_transport(&serde_json::json!({ "command": "x", "args": oversized_args }))
                .is_err()
        );
    }

    #[test]
    fn user_and_plugin_scan_namespaces_and_defaults_off() {
        let root = std::env::temp_dir().join(format!("integrator-mcp-{}", uuid::Uuid::new_v4()));
        let mcps = root.join("MCPs");
        let plugins = root.join("Plugins");
        fs::create_dir_all(&mcps).expect("mcps fixture");
        fs::create_dir_all(plugins.join("stripe-ai")).expect("plugin fixture");
        fs::write(
            mcps.join("playwright.json"),
            r#"{ "command": "npx", "args": ["@playwright/mcp@latest"] }"#,
        )
        .expect("user server");
        fs::write(
            mcps.join("pasted.json"),
            r#"{ "mcpServers": { "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] } } }"#,
        )
        .expect("pasted block");
        fs::write(
            plugins.join("stripe-ai").join("mcp.json"),
            r#"{ "mcpServers": { "stripe": { "url": "https://mcp.stripe.com" } } }"#,
        )
        .expect("plugin server");

        let mut servers = Vec::new();
        scan_user_root(&mcps, &mut servers);
        scan_plugin_root(&plugins, "plugin", &mut servers);
        let names = servers.iter().map(|s| s.name.as_str()).collect::<Vec<_>>();
        assert!(names.contains(&"playwright"));
        assert!(names.contains(&"memory"));
        assert!(names.contains(&"stripe-ai:stripe"));
        assert!(servers.iter().all(|server| !server.enabled));
        fs::remove_dir_all(root).expect("clean up mcp fixtures");
    }

    #[test]
    fn provider_projection_names_are_stable_and_collision_safe() {
        assert_eq!(
            projection_name("stripe-ai:stripe"),
            "integrator_mcp_stripe_2dai_3astripe"
        );
        assert_ne!(
            projection_name("stripe-ai:stripe"),
            projection_name("stripe-ai-stripe")
        );
    }

    #[test]
    fn configuration_revision_marks_only_older_resume_handles_stale() {
        let store = LocalStore::open_in_memory().expect("store");
        let stale = integrator_core::ProviderResumeState {
            task_id: integrator_core::TaskId::new(),
            provider: integrator_core::ProviderKind::Codex,
            session_ref: "thread-before-mcp".into(),
            repository_root: std::env::temp_dir(),
            permission: "project-write".into(),
            delegation: "off".into(),
            updated_at: chrono::Utc::now() - chrono::Duration::seconds(1),
        };
        assert!(resume_state_is_current(&store, &stale));

        mark_configuration_changed(&store).expect("revision");

        assert!(!resume_state_is_current(&store, &stale));
        let current = integrator_core::ProviderResumeState {
            updated_at: chrono::Utc::now() + chrono::Duration::seconds(1),
            ..stale
        };
        assert!(resume_state_is_current(&store, &current));
    }

    #[test]
    fn startup_revision_migrates_preexisting_enabled_servers_once() {
        let store = LocalStore::open_in_memory().expect("store");
        store
            .set_setting(
                ENABLED_SETTING_KEY,
                serde_json::json!({ "cloudflare-docs": true }),
            )
            .expect("enable server");

        ensure_configuration_revision(&store).expect("initial revision");
        let first = store
            .get_setting(REVISION_SETTING_KEY)
            .expect("read revision")
            .expect("revision");
        ensure_configuration_revision(&store).expect("idempotent revision");
        let second = store
            .get_setting(REVISION_SETTING_KEY)
            .expect("read revision")
            .expect("revision");

        assert_eq!(first.value, second.value);
        assert_eq!(first.updated_at, second.updated_at);
    }

    #[test]
    fn claude_config_merges_base_without_clobbering_and_sanitizes_keys() {
        let root = std::env::temp_dir().join(format!("mcp-proj-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("fixture root");
        let base = root.join("broker.json");
        fs::write(
            &base,
            r#"{ "mcpServers": { "integrator-broker": { "command": "broker" } } }"#,
        )
        .expect("base config");
        let servers = vec![IntegratorMcpServer {
            name: "stripe-ai:stripe".into(),
            source: "plugin".into(),
            origin: "stripe-ai".into(),
            enabled: true,
            credentials: Vec::new(),
            authorization: None,
            transport: McpTransport::Remote {
                url: "https://mcp.stripe.com".into(),
                oauth: true,
            },
        }];
        let path = write_claude_mcp_config(&root, &servers, Some(&base))
            .expect("projection")
            .expect("config path");
        let merged: Value =
            serde_json::from_str(&fs::read_to_string(path).expect("read")).expect("parse");
        assert!(merged.pointer("/mcpServers/integrator-broker").is_some());
        assert_eq!(
            merged
                .pointer("/mcpServers/integrator_mcp_stripe_2dai_3astripe/url")
                .and_then(Value::as_str),
            Some("https://mcp.stripe.com")
        );
        // Nothing to project → base rides through untouched.
        let untouched = write_claude_mcp_config(&root, &[], Some(&base)).expect("noop");
        assert_eq!(untouched.as_deref(), Some(base.as_path()));
        fs::remove_dir_all(root).expect("clean up projection fixtures");
    }

    #[test]
    fn codex_config_keeps_the_broker_and_adds_enabled_servers() {
        let merged = merge_codex_mcp_config(
            serde_json::json!({
                "mcp_servers": {
                    "integrator": { "command": "/Applications/AI Integrator" }
                }
            }),
            &[IntegratorMcpServer {
                name: "cloudflare-docs".into(),
                source: "user".into(),
                origin: "MCPs folder".into(),
                enabled: true,
                credentials: Vec::new(),
                authorization: None,
                transport: McpTransport::Remote {
                    url: "https://docs.mcp.cloudflare.com/mcp".into(),
                    oauth: false,
                },
            }],
        );
        assert!(merged.pointer("/mcp_servers/integrator").is_some());
        assert_eq!(
            merged
                .pointer("/mcp_servers/integrator_mcp_cloudflare_2ddocs/url")
                .and_then(Value::as_str),
            Some("https://docs.mcp.cloudflare.com/mcp")
        );
    }

    #[test]
    fn remote_oauth_headers_use_each_runtime_native_http_shape() {
        let server = IntegratorMcpServer {
            name: "figma".into(),
            source: "user".into(),
            origin: "MCPs folder".into(),
            enabled: true,
            credentials: Vec::new(),
            authorization: None,
            transport: McpTransport::Remote {
                url: "https://mcp.figma.com/mcp".into(),
                oauth: true,
            },
        };
        let headers = serde_json::Map::from_iter([(
            "Authorization".into(),
            Value::String("Bearer test-token".into()),
        )]);
        let codex = codex_server_config_with_headers(&server, headers.clone());
        let claude = claude_server_config_with_headers(&server, headers);
        assert_eq!(
            codex
                .pointer("/http_headers/Authorization")
                .and_then(Value::as_str),
            Some("Bearer test-token")
        );
        assert_eq!(
            claude
                .pointer("/headers/Authorization")
                .and_then(Value::as_str),
            Some("Bearer test-token")
        );
    }

    #[test]
    fn acp_projection_requires_http_capability_and_uses_absolute_stdio_commands() {
        let remote = IntegratorMcpServer {
            name: "cloudflare-docs".into(),
            source: "user".into(),
            origin: "MCPs folder".into(),
            enabled: true,
            credentials: Vec::new(),
            authorization: None,
            transport: McpTransport::Remote {
                url: "https://docs.mcp.cloudflare.com/mcp".into(),
                oauth: false,
            },
        };
        assert!(
            acp_mcp_server_entries(
                &[remote.clone()],
                AcpSessionCapabilities::default(),
                Path::new(".")
            )
            .is_err()
        );
        let projected = acp_mcp_server_entries(
            &[remote],
            AcpSessionCapabilities {
                mcp_http: true,
                ..AcpSessionCapabilities::default()
            },
            Path::new("."),
        )
        .expect("HTTP projection");
        assert_eq!(
            projected[0].get("type").and_then(Value::as_str),
            Some("http")
        );

        let executable = std::env::current_exe().expect("test executable");
        let stdio = IntegratorMcpServer {
            name: "local".into(),
            source: "user".into(),
            origin: "MCPs folder".into(),
            enabled: true,
            credentials: Vec::new(),
            authorization: None,
            transport: McpTransport::Stdio {
                command: executable.to_string_lossy().into_owned(),
                args: vec!["--mcp".into()],
                env: BTreeMap::from([("MODE".into(), "test".into())]),
            },
        };
        let projected =
            acp_mcp_server_entries(&[stdio], AcpSessionCapabilities::default(), Path::new("."))
                .expect("stdio");
        assert!(
            Path::new(
                projected[0]
                    .get("command")
                    .and_then(Value::as_str)
                    .expect("command")
            )
            .is_absolute()
        );
        assert_eq!(
            projected[0].pointer("/env/0/name").and_then(Value::as_str),
            Some("MODE")
        );
    }

    #[test]
    fn antigravity_projection_lives_in_the_private_control_overlay() {
        let root = std::env::temp_dir().join(format!("agy-mcp-{}", uuid::Uuid::new_v4()));
        let path = write_antigravity_mcp_config(
            &root,
            &[IntegratorMcpServer {
                name: "cloudflare-docs".into(),
                source: "user".into(),
                origin: "MCPs folder".into(),
                enabled: true,
                credentials: Vec::new(),
                authorization: None,
                transport: McpTransport::Remote {
                    url: "https://docs.mcp.cloudflare.com/mcp".into(),
                    oauth: false,
                },
            }],
        )
        .expect("Antigravity projection")
        .expect("projection path");
        assert_eq!(path, root.join(".agents/mcp_config.json"));
        let config: Value = serde_json::from_slice(&fs::read(&path).expect("read projection"))
            .expect("parse projection");
        assert_eq!(
            config
                .pointer("/mcpServers/integrator_mcp_cloudflare_2ddocs/serverUrl")
                .and_then(Value::as_str),
            Some("https://docs.mcp.cloudflare.com/mcp")
        );
        assert_eq!(
            config
                .pointer("/mcpServers/integrator_mcp_cloudflare_2ddocs/transport")
                .and_then(Value::as_str),
            Some("http")
        );
        write_antigravity_mcp_config(&root, &[]).expect("clear projection");
        assert!(!path.exists());
        fs::remove_dir_all(root).expect("clean up Antigravity projection");
    }
}
