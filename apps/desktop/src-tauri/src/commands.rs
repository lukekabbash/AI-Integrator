use std::{
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::Arc,
};

use adapter_codex::{CodexEvent, CodexLaunchOptions, ServerRequestId};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use integrator_core::{
    ApprovalDecision, ApprovalProjection, ConnectionState, IntegratorError, LocalExport, NewTask,
    ProjectId, ProviderKind, RuntimeBinding, RuntimeProjection, RuntimeSession, Setting,
    StopRequestResult, Task, TaskId, TaskSnapshot, TaskState, TransportRequestId, TrustedProject,
    TurnStatus, Versioned,
};
use integrator_runtime::{
    CommitResult, CreateWorktree, DiffResult, DiffScope, FileStatus, GitService,
    ProjectionMutation, ProviderEventInput, PushPreview, ReducedProviderEvent, RepositoryIdentity,
    StructuredCliEventKind, StructuredCliLaunchOptions, StructuredCliProvider,
    StructuredPermissionMode, StructuredUsage, WorktreeInfo, acp_turn_projection,
    authorize_repository, discover_providers, provider_executable, reduce_acp_permission_request,
    reduce_acp_update, reduce_connection_event, reduce_provider_event,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use session_store::LocalStore;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Duration, timeout};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest, http::header};

use crate::state::{
    AcpPermissionOption, AcpRuntime, AppState, CodexRuntime, PendingStructuredPermission,
    StructuredRuntime, VoiceTypingCommand, VoiceTypingSession,
};

pub(crate) type CommandResult<T> = std::result::Result<T, CommandError>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    code: &'static str,
    message: String,
}

impl From<IntegratorError> for CommandError {
    fn from(error: IntegratorError) -> Self {
        let code = match &error {
            IntegratorError::InvalidInput(_) => "invalid-input",
            IntegratorError::NotFound(_) => "not-found",
            IntegratorError::Unavailable(_) => "unavailable",
            IntegratorError::Unauthorized(_) => "unauthorized",
            IntegratorError::Protocol(_) => "provider-protocol",
            IntegratorError::Storage(_) => "storage",
            IntegratorError::Git(_) => "git",
            IntegratorError::Io(_) => "io",
            IntegratorError::Serialization(_) => "serialization",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    application_version: String,
    domain_schema_version: u32,
    data_directory: PathBuf,
    git_available: bool,
    local_only: bool,
}

#[tauri::command]
pub fn app_bootstrap(state: State<'_, AppState>) -> Versioned<Bootstrap> {
    Versioned::current(Bootstrap {
        application_version: env!("CARGO_PKG_VERSION").into(),
        domain_schema_version: integrator_core::DOMAIN_SCHEMA_VERSION,
        data_directory: state.data_directory.clone(),
        git_available: state.git.is_some(),
        local_only: true,
    })
}

/// Opens a user-visible HTTP(S) URL with the operating system's default
/// browser. The renderer can request only this narrowly validated action; it
/// never receives general process-launch authority.
#[tauri::command]
pub fn open_external_url(url: String) -> CommandResult<()> {
    let parsed = url::Url::parse(&url).map_err(|_| CommandError {
        code: "invalid-input",
        message: "only absolute HTTP(S) URLs can be opened externally".into(),
    })?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(CommandError {
            code: "invalid-input",
            message: "only absolute HTTP(S) URLs can be opened externally".into(),
        });
    }

    #[cfg(target_os = "windows")]
    let result = Command::new("explorer.exe").arg(parsed.as_str()).spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(parsed.as_str()).spawn();
    #[cfg(target_os = "linux")]
    let result = Command::new("xdg-open").arg(parsed.as_str()).spawn();
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let result: std::io::Result<std::process::Child> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "opening external URLs is not supported on this platform",
    ));

    result.map(|_| ()).map_err(|error| CommandError {
        code: "external-open-failed",
        message: format!("could not open the default browser: {error}"),
    })
}

#[tauri::command]
pub async fn provider_discover() -> CommandResult<Vec<integrator_core::ProviderStatus>> {
    let statuses = tauri::async_runtime::spawn_blocking(discover_providers)
        .await
        .map_err(|_| worker_error())?;
    Ok(statuses)
}

#[tauri::command]
pub async fn task_create(state: State<'_, AppState>, input: NewTask) -> CommandResult<Task> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.create_task(input))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn task_list(state: State<'_, AppState>) -> CommandResult<Vec<Task>> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.list_tasks())
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn task_set_state(
    state: State<'_, AppState>,
    task_id: TaskId,
    task_state: TaskState,
) -> CommandResult<Task> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.update_task_state(task_id, task_state))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskMetadataInput {
    title: Option<String>,
    pinned: Option<bool>,
    archived: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRoutingInput {
    runtime: String,
    model: String,
    effort: Option<String>,
}

#[tauri::command]
pub async fn task_update_metadata(
    state: State<'_, AppState>,
    task_id: TaskId,
    input: TaskMetadataInput,
) -> CommandResult<Task> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        store.update_task_metadata(task_id, input.title, input.pinned, input.archived)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn task_update_routing(
    state: State<'_, AppState>,
    task_id: TaskId,
    input: TaskRoutingInput,
) -> CommandResult<Task> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        store.update_task_routing(
            task_id,
            &input.runtime,
            &input.model,
            input.effort.as_deref(),
        )
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn setting_list(state: State<'_, AppState>) -> CommandResult<Vec<Setting>> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.list_settings())
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn setting_set(
    state: State<'_, AppState>,
    key: String,
    value: Value,
) -> CommandResult<Setting> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.set_setting(&key, value))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn session_list(state: State<'_, AppState>) -> CommandResult<Vec<RuntimeSession>> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.list_runtime_sessions())
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn local_export(state: State<'_, AppState>) -> CommandResult<LocalExport> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.export())
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn local_clear(state: State<'_, AppState>) -> CommandResult<()> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.clear_all_data())
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageTotals {
    total_bytes: u64,
    database_bytes: u64,
    wal_bytes: u64,
    shared_memory_bytes: u64,
    measured_at: DateTime<Utc>,
    kind: &'static str,
}

/// One provider-reported rate-limit window (Codex `RateLimitWindow`).
/// `resets_at` is a Unix timestamp in seconds.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionWindow {
    used_percent: f64,
    #[serde(default)]
    window_duration_mins: Option<u64>,
    #[serde(default)]
    resets_at: Option<i64>,
}

/// Provider-reported subscription quota. Never inferred: only providers that
/// publish rate-limit windows (Codex today) populate this.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionQuota {
    #[serde(default)]
    plan_type: Option<String>,
    #[serde(default)]
    primary: Option<SubscriptionWindow>,
    #[serde(default)]
    secondary: Option<SubscriptionWindow>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsageSummary {
    provider: String,
    task_count: u64,
    turn_count: u64,
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
    total_tokens: u64,
    model_context_window: Option<u64>,
    /// Vendor-computed API-equivalent cost in USD. Only providers that report
    /// one (Claude's `total_cost_usd`) populate it; it is an estimate, not a
    /// bill, and is absent rather than inferred elsewhere.
    estimated_cost_usd: Option<f64>,
    /// Provider-reported subscription windows; absent when the provider does
    /// not expose quota (it is never inferred).
    subscription: Option<SubscriptionQuota>,
    provenance: &'static str,
    detail: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    providers: Vec<ProviderUsageSummary>,
    measured_at: DateTime<Utc>,
}

fn file_size(path: PathBuf) -> u64 {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

#[tauri::command]
pub fn storage_totals(state: State<'_, AppState>) -> CommandResult<StorageTotals> {
    let database_bytes = file_size(state.data_directory.join("integrator.sqlite3"));
    let wal_bytes = file_size(state.data_directory.join("integrator.sqlite3-wal"));
    let shared_memory_bytes = file_size(state.data_directory.join("integrator.sqlite3-shm"));
    Ok(StorageTotals {
        total_bytes: database_bytes
            .saturating_add(wal_bytes)
            .saturating_add(shared_memory_bytes),
        database_bytes,
        wal_bytes,
        shared_memory_bytes,
        measured_at: Utc::now(),
        kind: "sqlite",
    })
}

#[tauri::command]
pub async fn usage_summary(state: State<'_, AppState>) -> CommandResult<UsageSummary> {
    let store = Arc::clone(&state.store);
    let (rows, settings) = tauri::async_runtime::spawn_blocking(move || {
        let rows = store.provider_usage_rows()?;
        let settings = store.list_settings()?;
        Ok::<_, integrator_core::IntegratorError>((rows, settings))
    })
    .await
    .map_err(|_| worker_error())??;
    let quota_for = |provider: &str| -> Option<SubscriptionQuota> {
        let key = format!("provider-quota.{provider}");
        settings
            .iter()
            .find(|setting| setting.key == key)
            .and_then(|setting| serde_json::from_value(setting.value.clone()).ok())
    };
    let providers = rows
        .into_iter()
        .map(|(provider, task_count, turn_count, usage)| {
            let subscription = quota_for(&provider);
            ProviderUsageSummary {
                provider,
                task_count,
                turn_count,
                input_tokens: usage.input_tokens,
                cached_input_tokens: usage.cached_input_tokens,
                output_tokens: usage.output_tokens,
                reasoning_output_tokens: usage.reasoning_output_tokens,
                total_tokens: usage.total_tokens,
                model_context_window: usage.model_context_window,
                estimated_cost_usd: usage
                    .vendor_cost_micro_usd
                    .map(|micro| micro as f64 / 1_000_000.0),
                subscription,
                provenance: if usage.total_tokens > 0 {
                    "vendor_exact"
                } else {
                    "unavailable"
                },
                detail: if usage.total_tokens > 0 {
                    "Provider-reported token usage from the persisted native projection.".into()
                } else {
                    "No provider token usage has been reported for this runtime.".into()
                },
            }
        })
        .collect();
    Ok(UsageSummary {
        providers,
        measured_at: Utc::now(),
    })
}

/// Persists provider-reported subscription windows from a rate-limit snapshot
/// (`account/rateLimits/read` response or `account/rateLimits/updated`
/// notification — both carry `rateLimits`). Rolling updates are sparse, so
/// absent windows keep the previously stored values instead of clearing them.
fn store_provider_quota(store: &LocalStore, provider: ProviderKind, params: &Value) {
    let Some(snapshot) = params.get("rateLimits") else {
        return;
    };
    let key = format!("provider-quota.{}", provider.as_str());
    let existing = store
        .list_settings()
        .ok()
        .and_then(|settings| settings.into_iter().find(|setting| setting.key == key))
        .map(|setting| setting.value)
        .unwrap_or(Value::Null);
    let window = |name: &str| -> Value {
        snapshot
            .get(name)
            .filter(|window| window.get("usedPercent").is_some())
            .cloned()
            .unwrap_or_else(|| existing.get(name).cloned().unwrap_or(Value::Null))
    };
    let plan_type = snapshot
        .get("planType")
        .and_then(Value::as_str)
        .or_else(|| existing.get("planType").and_then(Value::as_str))
        .map(str::to_owned);
    let value = serde_json::json!({
        "planType": plan_type,
        "primary": window("primary"),
        "secondary": window("secondary"),
        "updatedAt": Utc::now().to_rfc3339(),
    });
    let _ = store.set_setting(&key, value);
}

const VOICE_TYPING_SERVICE: &str = "ai-integrator";
const VOICE_TYPING_ACCOUNT: &str = "openai-stt";
const VOICE_TYPING_EVENT: &str = "voice-typing://event";
const VOICE_TYPING_URL: &str = "wss://api.openai.com/v1/realtime?intent=transcription";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTypingCredentialStatus {
    configured: bool,
    storage: &'static str,
    provider: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceTypingEvent {
    kind: &'static str,
    text: String,
}

#[derive(Debug, Deserialize)]
struct RealtimeServerEvent {
    #[serde(rename = "type")]
    event_type: String,
    delta: Option<String>,
    transcript: Option<String>,
    error: Option<RealtimeError>,
}

#[derive(Debug, Deserialize)]
struct RealtimeError {
    code: Option<String>,
    message: Option<String>,
}

fn voice_typing_error(message: impl Into<String>) -> CommandError {
    CommandError {
        code: "voice-typing",
        message: message.into(),
    }
}

fn credential_entry() -> CommandResult<keyring::Entry> {
    keyring::Entry::new(VOICE_TYPING_SERVICE, VOICE_TYPING_ACCOUNT).map_err(|_| CommandError {
        code: "credential-store-unavailable",
        message: "The operating system credential store is unavailable.".into(),
    })
}

fn voice_typing_lock(
    state: &AppState,
) -> CommandResult<std::sync::MutexGuard<'_, Option<VoiceTypingSession>>> {
    state
        .voice_typing
        .lock()
        .map_err(|_| voice_typing_error("Voice typing state is unavailable."))
}

#[tauri::command]
pub fn voice_typing_credential_status() -> CommandResult<VoiceTypingCredentialStatus> {
    let entry = credential_entry()?;
    let configured = match entry.get_password() {
        Ok(value) => !value.is_empty(),
        Err(keyring::Error::NoEntry) => false,
        Err(_) => {
            return Err(CommandError {
                code: "credential-store-unavailable",
                message: "The operating system credential store could not be read.".into(),
            });
        }
    };
    Ok(VoiceTypingCredentialStatus {
        configured,
        storage: "os-credential-store",
        provider: "openai",
    })
}

#[tauri::command]
pub fn voice_typing_credential_set(api_key: String) -> CommandResult<VoiceTypingCredentialStatus> {
    let value = api_key.trim();
    if value.is_empty() {
        return Err(voice_typing_error("Paste an OpenAI API key before saving."));
    }
    let entry = credential_entry()?;
    entry.set_password(value).map_err(|_| CommandError {
        code: "credential-store-unavailable",
        message: "The OpenAI API key could not be saved to the operating system credential store."
            .into(),
    })?;
    Ok(VoiceTypingCredentialStatus {
        configured: true,
        storage: "os-credential-store",
        provider: "openai",
    })
}

#[tauri::command]
pub fn voice_typing_credential_clear() -> CommandResult<()> {
    let entry = credential_entry()?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(CommandError {
            code: "credential-store-unavailable",
            message: "The OpenAI API key could not be removed from the operating system credential store."
                .into(),
        }),
    }
}

#[tauri::command]
pub async fn voice_typing_start(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    if voice_typing_lock(&state)?.is_some() {
        return Err(voice_typing_error("Voice typing is already active."));
    }
    let entry = credential_entry()?;
    let api_key = entry.get_password().map_err(|_| {
        voice_typing_error("Add an OpenAI API key in Settings before using the mic button.")
    })?;
    if api_key.trim().is_empty() {
        return Err(voice_typing_error(
            "Add an OpenAI API key in Settings before using the mic button.",
        ));
    }

    let mut request = VOICE_TYPING_URL
        .into_client_request()
        .map_err(|_| voice_typing_error("The voice typing connection could not be created."))?;
    let authorization = header::HeaderValue::from_str(&format!("Bearer {}", api_key.trim()))
        .map_err(|_| voice_typing_error("The OpenAI API key format is not valid."))?;
    request
        .headers_mut()
        .insert(header::AUTHORIZATION, authorization);

    let (mut socket, _) = connect_async(request)
        .await
        .map_err(|_| voice_typing_error("Could not connect to OpenAI Realtime transcription."))?;
    let session_update = serde_json::json!({
        "type": "session.update",
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "format": {"type": "audio/pcm", "rate": 24000},
                    // Whisper only returns whole utterances after the fact; the
                    // gpt-4o transcribe family streams partial deltas so words
                    // can appear in the composer while the user is speaking.
                    "transcription": {
                        "model": "gpt-4o-mini-transcribe"
                    },
                    // Live typing depends on the server committing speech
                    // segments itself; without VAD nothing is transcribed
                    // until the final commit at stop.
                    "turn_detection": {
                        "type": "server_vad",
                        "silence_duration_ms": 250,
                        "prefix_padding_ms": 300
                    }
                }
            }
        }
    });
    socket
        .send(Message::Text(session_update.to_string().into()))
        .await
        .map_err(|_| voice_typing_error("OpenAI Realtime transcription rejected the session."))?;
    drop(api_key);

    let already_active = voice_typing_lock(&state)?.is_some();
    if already_active {
        let _ = socket.close(None).await;
        return Err(voice_typing_error("Voice typing is already active."));
    }
    let (sender, receiver) = mpsc::channel(32);
    {
        let mut active = voice_typing_lock(&state)?;
        if active.is_some() {
            return Err(voice_typing_error("Voice typing is already active."));
        }
        *active = Some(VoiceTypingSession { sender });
    }

    let cleanup_app = app.clone();
    tauri::async_runtime::spawn(async move {
        run_voice_typing(socket, receiver, app).await;
        if let Some(state) = cleanup_app.try_state::<AppState>() {
            if let Ok(mut active) = state.voice_typing.lock() {
                active.take();
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn voice_typing_append(state: State<'_, AppState>, pcm: Vec<u8>) -> CommandResult<()> {
    eprintln!("[voice-typing] append received {} bytes", pcm.len());
    if pcm.is_empty() {
        return Ok(());
    }
    if pcm.len() > 128 * 1024 {
        return Err(voice_typing_error(
            "The voice typing audio chunk is too large.",
        ));
    }
    let sender = voice_typing_lock(&state)?
        .as_ref()
        .map(|session| session.sender.clone())
        .ok_or_else(|| voice_typing_error("Voice typing is not active."))?;
    sender
        .send(VoiceTypingCommand::Append(pcm))
        .await
        .map_err(|_| voice_typing_error("The voice typing connection ended."))
}

#[tauri::command]
pub async fn voice_typing_stop(state: State<'_, AppState>) -> CommandResult<()> {
    let sender = voice_typing_lock(&state)?
        .as_ref()
        .map(|session| session.sender.clone())
        .ok_or_else(|| voice_typing_error("Voice typing is not active."))?;
    let (done_sender, done_receiver) = oneshot::channel();
    sender
        .send(VoiceTypingCommand::Stop(done_sender))
        .await
        .map_err(|_| voice_typing_error("The voice typing connection ended."))?;
    timeout(Duration::from_secs(3), done_receiver)
        .await
        .map_err(|_| voice_typing_error("Voice typing timed out while finalizing the transcript."))?
        .map_err(|_| voice_typing_error("The voice typing connection ended."))?;
    Ok(())
}

fn emit_voice_typing_event(app: &AppHandle, kind: &'static str, text: String) {
    let _ = app.emit(VOICE_TYPING_EVENT, VoiceTypingEvent { kind, text });
}

fn handle_voice_typing_message(app: &AppHandle, message: Message) -> bool {
    let Message::Text(text) = message else {
        return false;
    };
    let Ok(event) = serde_json::from_str::<RealtimeServerEvent>(&text) else {
        return false;
    };
    // Session rejections and transcription failures otherwise vanish silently,
    // leaving "no words appear" with nothing to diagnose from.
    if matches!(event.event_type.as_str(), "error")
        || event.event_type.ends_with(".failed")
        || event.event_type.ends_with("session.updated")
        || event.event_type.ends_with("session.created")
        || event.event_type.starts_with("input_audio_buffer.")
        || event.event_type.ends_with(".delta")
        || event.event_type.ends_with(".completed")
    {
        eprintln!("[voice-typing] {text}");
    }
    match event.event_type.as_str() {
        "conversation.item.input_audio_transcription.delta" => {
            if let Some(delta) = event.delta.filter(|value| !value.is_empty()) {
                emit_voice_typing_event(app, "delta", delta);
            }
            false
        }
        "conversation.item.input_audio_transcription.completed" => {
            emit_voice_typing_event(app, "completed", event.transcript.unwrap_or_default());
            true
        }
        "conversation.item.input_audio_transcription.failed" => {
            emit_voice_typing_event(
                app,
                "error",
                "Transcription of a speech segment failed; keep talking or restart the mic.".into(),
            );
            false
        }
        "error" => {
            let error = event.error;
            // The stop-time safety commit races with server VAD, which usually
            // has already committed all speech; an empty-buffer complaint there
            // is expected and also signals nothing further is pending.
            if error
                .as_ref()
                .and_then(|error| error.code.as_deref())
                .is_some_and(|code| code == "input_audio_buffer_commit_empty")
            {
                return true;
            }
            emit_voice_typing_event(
                app,
                "error",
                error
                    .and_then(|error| error.message)
                    .unwrap_or_else(|| "OpenAI Realtime transcription returned an error.".into()),
            );
            false
        }
        _ => false,
    }
}

async fn wait_for_voice_typing_completion<S>(socket: &mut WebSocketStream<S>, app: &AppHandle)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    while let Some(result) = socket.next().await {
        match result {
            Ok(message) => {
                if handle_voice_typing_message(app, message) {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

async fn run_voice_typing<S>(
    mut socket: WebSocketStream<S>,
    mut receiver: mpsc::Receiver<VoiceTypingCommand>,
    app: AppHandle,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    loop {
        tokio::select! {
            incoming = socket.next() => {
                match incoming {
                    Some(Ok(message)) => {
                        if matches!(message, Message::Close(_)) {
                            break;
                        }
                        let _ = handle_voice_typing_message(&app, message);
                    }
                    Some(Err(_)) | None => break,
                }
            }
            command = receiver.recv() => {
                let Some(command) = command else { break };
                match command {
                    VoiceTypingCommand::Append(pcm) => {
                        eprintln!("[voice-typing] sending {} bytes to OpenAI", pcm.len());
                        let append = serde_json::json!({
                            "type": "input_audio_buffer.append",
                            "audio": BASE64.encode(pcm),
                        });
                        if socket.send(Message::Text(append.to_string().into())).await.is_err() {
                            emit_voice_typing_event(&app, "error", "The voice typing connection ended.".into());
                            break;
                        }
                    }
                    VoiceTypingCommand::Stop(done_sender) => {
                        let commit = serde_json::json!({"type": "input_audio_buffer.commit"});
                        if socket.send(Message::Text(commit.to_string().into())).await.is_ok() {
                            let _ = timeout(
                                Duration::from_secs(2),
                                wait_for_voice_typing_completion(&mut socket, &app),
                            )
                            .await;
                        }
                        let _ = done_sender.send(());
                        let _ = socket.close(None).await;
                        break;
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub async fn project_register(
    state: State<'_, AppState>,
    path: PathBuf,
) -> CommandResult<TrustedProject> {
    let git = state.git.clone().ok_or_else(git_unavailable)?;
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        let identity = git.repository(&path)?;
        let display_name = identity
            .root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Repository")
            .chars()
            .take(120)
            .collect::<String>();
        store.upsert_trusted_project(&display_name, &identity.root, &identity.common_directory)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

/// Windows forbids `<>:"/\|?*` in file names and trailing dots/spaces; the
/// same rules keep the folder portable everywhere else.
fn validate_project_name(name: &str) -> Result<(), IntegratorError> {
    let name = name.trim();
    if name.is_empty() || name.len() > 120 {
        return Err(IntegratorError::InvalidInput(
            "project name must be between 1 and 120 characters".into(),
        ));
    }
    if name == "." || name == ".." {
        return Err(IntegratorError::InvalidInput(
            "project name cannot be a relative path".into(),
        ));
    }
    if name.chars().any(|c| {
        matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control()
    }) || name.ends_with('.')
    {
        return Err(IntegratorError::InvalidInput(
            "project name contains characters that are not allowed in folder names".into(),
        ));
    }
    Ok(())
}

/// Create a brand-new project folder under `parent`, initialize a Git
/// repository inside it, and register it as a trusted project.
#[tauri::command]
pub async fn project_create(
    state: State<'_, AppState>,
    parent: PathBuf,
    name: String,
) -> CommandResult<TrustedProject> {
    let git = state.git.clone().ok_or_else(git_unavailable)?;
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || {
        let name = name.trim().to_string();
        validate_project_name(&name)?;
        if !parent.is_dir() {
            return Err(IntegratorError::InvalidInput(
                "the chosen location is not an existing folder".into(),
            ));
        }
        let destination = parent.join(&name);
        fs::create_dir(&destination).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                IntegratorError::InvalidInput(format!(
                    "a folder named \"{name}\" already exists here"
                ))
            } else {
                IntegratorError::Io(error)
            }
        })?;
        let identity = git.init(&destination)?;
        store.upsert_trusted_project(&name, &identity.root, &identity.common_directory)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn project_list(state: State<'_, AppState>) -> CommandResult<Vec<TrustedProject>> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.list_trusted_projects())
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn project_remove(
    state: State<'_, AppState>,
    project_id: ProjectId,
) -> CommandResult<()> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.remove_trusted_project(project_id))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_repository(
    state: State<'_, AppState>,
    path: PathBuf,
) -> CommandResult<RepositoryIdentity> {
    let (_, identity) = authorized_git(&state, path).await?;
    Ok(identity)
}

#[tauri::command]
pub async fn git_worktrees(
    state: State<'_, AppState>,
    repository: PathBuf,
) -> CommandResult<Vec<WorktreeInfo>> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.worktrees(&identity.root))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_worktree_create(
    state: State<'_, AppState>,
    repository: PathBuf,
    request: CreateWorktree,
) -> CommandResult<Vec<WorktreeInfo>> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.create_worktree(&identity.root, &request))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_status(
    state: State<'_, AppState>,
    repository: PathBuf,
) -> CommandResult<Vec<FileStatus>> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.status(&identity.root))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

const MAX_PROJECT_FILE_ENTRIES: usize = 5_000;
const MAX_PROJECT_FILE_BYTES: u64 = 1_000_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileEntry {
    path: String,
    size: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileReadInput {
    path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileContent {
    path: String,
    content: String,
    is_binary: bool,
}

/// Lists ordinary files inside an explicitly trusted repository. We do not
/// follow symlinks or descend into generated/dependency directories, which
/// keeps the UI tree bounded and prevents a project from exposing arbitrary
/// machine paths through a benign-looking entry.
#[tauri::command]
pub async fn project_file_list(
    state: State<'_, AppState>,
    repository: PathBuf,
) -> CommandResult<Vec<ProjectFileEntry>> {
    let (_, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || list_project_files(&identity.root))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn project_file_read(
    state: State<'_, AppState>,
    repository: PathBuf,
    input: ProjectFileReadInput,
) -> CommandResult<ProjectFileContent> {
    let (_, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || read_project_file(&identity.root, &input.path))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_diff(
    state: State<'_, AppState>,
    repository: PathBuf,
    scope: DiffScope,
    path: Option<PathBuf>,
) -> CommandResult<DiffResult> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.diff(&identity.root, scope, path.as_deref()))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_stage(
    state: State<'_, AppState>,
    repository: PathBuf,
    paths: Vec<PathBuf>,
) -> CommandResult<Vec<FileStatus>> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.stage(&identity.root, &paths))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_unstage(
    state: State<'_, AppState>,
    repository: PathBuf,
    paths: Vec<PathBuf>,
) -> CommandResult<Vec<FileStatus>> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.unstage(&identity.root, &paths))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_commit(
    state: State<'_, AppState>,
    repository: PathBuf,
    message: String,
) -> CommandResult<CommitResult> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.commit(&identity.root, &message))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_push_preview(
    state: State<'_, AppState>,
    repository: PathBuf,
) -> CommandResult<PushPreview> {
    let (git, identity) = authorized_git(&state, repository).await?;
    tauri::async_runtime::spawn_blocking(move || git.push_preview(&identity.root))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

const MAX_TERMINAL_OUTPUT_LINES: usize = 4_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    id: String,
    cwd: String,
    shell: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommandStarted {
    /// Absent when the command completed inline (blank input or a `cd`).
    run_id: Option<String>,
    cwd: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputPayload {
    session_id: String,
    run_id: String,
    stream: &'static str,
    line: Option<String>,
    exit_code: Option<i32>,
    cwd: String,
}

/// Opens an interactive terminal session rooted at an explicitly trusted
/// repository. This is the only place the renderer gains command execution,
/// and every command it sends runs inside the trusted root with the user
/// typing it — never a provider or a remote payload.
#[tauri::command]
pub async fn terminal_open(
    state: State<'_, AppState>,
    repository: PathBuf,
) -> CommandResult<TerminalSessionInfo> {
    let (_, identity) = authorized_git(&state, repository).await?;
    let root = dunce::canonicalize(&identity.root).map_err(|error| CommandError {
        code: "terminal-unavailable",
        message: format!("could not resolve the repository root: {error}"),
    })?;
    let id = uuid::Uuid::new_v4().to_string();
    let info = TerminalSessionInfo {
        id: id.clone(),
        cwd: display_path(&root),
        shell: terminal_shell_label().into(),
    };
    state.terminals.lock().expect("terminal lock").insert(
        id,
        crate::state::TerminalSession {
            root: root.clone(),
            cwd: root,
            running: None,
        },
    );
    Ok(info)
}

#[tauri::command]
pub async fn terminal_run(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    session_id: String,
    command: String,
) -> CommandResult<TerminalCommandStarted> {
    let trimmed = command.trim().to_owned();
    let (root, cwd) = {
        let sessions = state.terminals.lock().expect("terminal lock");
        let session = sessions.get(&session_id).ok_or_else(unknown_terminal)?;
        if session.running.is_some() {
            return Err(CommandError {
                code: "terminal-busy",
                message: "a command is already running in this terminal".into(),
            });
        }
        (session.root.clone(), session.cwd.clone())
    };
    if trimmed.is_empty() {
        return Ok(TerminalCommandStarted {
            run_id: None,
            cwd: display_path(&cwd),
        });
    }
    if let Some(target) = parse_cd_command(&trimmed) {
        let next = resolve_terminal_cd(&root, &cwd, target)?;
        let mut sessions = state.terminals.lock().expect("terminal lock");
        let session = sessions.get_mut(&session_id).ok_or_else(unknown_terminal)?;
        session.cwd = next.clone();
        return Ok(TerminalCommandStarted {
            run_id: None,
            cwd: display_path(&next),
        });
    }

    let run_id = uuid::Uuid::new_v4().to_string();
    let mut child = spawn_terminal_shell(&trimmed, &cwd)?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (kill_tx, kill_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut sessions = state.terminals.lock().expect("terminal lock");
        let session = sessions.get_mut(&session_id).ok_or_else(unknown_terminal)?;
        session.running = Some(crate::state::TerminalRun {
            run_id: run_id.clone(),
            kill: kill_tx,
        });
    }

    let cwd_display = display_path(&cwd);
    let out_task = stdout.map(|pipe| {
        tauri::async_runtime::spawn(pump_terminal_pipe(
            app.clone(),
            session_id.clone(),
            run_id.clone(),
            cwd_display.clone(),
            "stdout",
            pipe,
        ))
    });
    let err_task = stderr.map(|pipe| {
        tauri::async_runtime::spawn(pump_terminal_pipe(
            app.clone(),
            session_id.clone(),
            run_id.clone(),
            cwd_display.clone(),
            "stderr",
            pipe,
        ))
    });

    let waiter_app = app;
    let waiter_session = session_id.clone();
    let waiter_run = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut kill_rx = kill_rx;
        let status = tokio::select! {
            status = child.wait() => status.ok(),
            _ = &mut kill_rx => {
                let _ = child.start_kill();
                child.wait().await.ok()
            }
        };
        // Flush remaining pipe output before reporting completion so exit
        // never overtakes the command's own final lines.
        if let Some(task) = out_task {
            let _ = task.await;
        }
        if let Some(task) = err_task {
            let _ = task.await;
        }
        let cwd = {
            let state = waiter_app.state::<AppState>();
            let mut sessions = state.terminals.lock().expect("terminal lock");
            match sessions.get_mut(&waiter_session) {
                Some(session) => {
                    if session
                        .running
                        .as_ref()
                        .is_some_and(|run| run.run_id == waiter_run)
                    {
                        session.running = None;
                    }
                    display_path(&session.cwd)
                }
                None => return,
            }
        };
        let _ = waiter_app.emit(
            "terminal://output",
            &TerminalOutputPayload {
                session_id: waiter_session,
                run_id: waiter_run,
                stream: "exit",
                line: None,
                exit_code: status.and_then(|status| status.code()),
                cwd,
            },
        );
    });

    Ok(TerminalCommandStarted {
        run_id: Some(run_id),
        cwd: cwd_display,
    })
}

#[tauri::command]
pub fn terminal_interrupt(state: State<'_, AppState>, session_id: String) -> CommandResult<()> {
    let run = {
        let mut sessions = state.terminals.lock().expect("terminal lock");
        let session = sessions.get_mut(&session_id).ok_or_else(unknown_terminal)?;
        session.running.take()
    };
    if let Some(run) = run {
        let _ = run.kill.send(());
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_close(state: State<'_, AppState>, session_id: String) -> CommandResult<()> {
    let session = state
        .terminals
        .lock()
        .expect("terminal lock")
        .remove(&session_id);
    if let Some(session) = session {
        if let Some(run) = session.running {
            let _ = run.kill.send(());
        }
    }
    Ok(())
}

fn unknown_terminal() -> CommandError {
    CommandError {
        code: "not-found",
        message: "unknown terminal session".into(),
    }
}

fn terminal_shell_label() -> &'static str {
    if cfg!(windows) { "PowerShell" } else { "sh" }
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Recognizes the `cd` builtin the session handles itself; everything else
/// goes to the shell. Bare `cd` (and `cd ~`) returns to the project root
/// because a terminal session never leaves the trusted repository.
fn parse_cd_command(command: &str) -> Option<&str> {
    if command == "cd" {
        return Some("");
    }
    command
        .strip_prefix("cd ")
        .map(str::trim)
        .map(|target| target.trim_matches(|quote| quote == '"' || quote == '\''))
}

fn resolve_terminal_cd(
    root: &Path,
    cwd: &Path,
    target: &str,
) -> std::result::Result<PathBuf, CommandError> {
    if target.is_empty() || target == "~" {
        return Ok(root.to_path_buf());
    }
    let raw = Path::new(target);
    let candidate = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        cwd.join(raw)
    };
    let canonical = dunce::canonicalize(&candidate).map_err(|_| CommandError {
        code: "invalid-input",
        message: format!("cd: no such directory: {target}"),
    })?;
    if !canonical.starts_with(root) {
        return Err(CommandError {
            code: "unauthorized",
            message: "cd: terminal sessions stay inside the trusted project".into(),
        });
    }
    if !canonical.is_dir() {
        return Err(CommandError {
            code: "invalid-input",
            message: format!("cd: not a directory: {target}"),
        });
    }
    Ok(canonical)
}

fn spawn_terminal_shell(
    command: &str,
    cwd: &Path,
) -> std::result::Result<tokio::process::Child, CommandError> {
    #[cfg(windows)]
    let mut builder = {
        // -EncodedCommand sidesteps PowerShell re-parsing the quoted argument
        // string, so the user's command arrives byte-for-byte. UTF-8 console
        // output keeps non-ASCII tool output readable in the drawer.
        let script = format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n{command}\nif ($LASTEXITCODE -ne $null) {{ exit $LASTEXITCODE }}"
        );
        let utf16: Vec<u8> = script
            .encode_utf16()
            .flat_map(|unit| unit.to_le_bytes())
            .collect();
        let encoded = BASE64.encode(&utf16);
        let mut builder = tokio::process::Command::new("powershell.exe");
        builder.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &encoded,
        ]);
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        builder.creation_flags(CREATE_NO_WINDOW);
        builder
    };
    #[cfg(not(windows))]
    let mut builder = {
        let mut builder = tokio::process::Command::new("/bin/sh");
        builder.args(["-c", command]);
        builder
    };
    builder
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    builder.spawn().map_err(|error| CommandError {
        code: "terminal-spawn-failed",
        message: format!("could not start the shell: {error}"),
    })
}

async fn pump_terminal_pipe<R>(
    app: AppHandle<tauri::Wry>,
    session_id: String,
    run_id: String,
    cwd: String,
    stream: &'static str,
    pipe: R,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncBufReadExt;
    let mut reader = tokio::io::BufReader::new(pipe);
    let mut buffer = Vec::new();
    let mut emitted = 0usize;
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if emitted >= MAX_TERMINAL_OUTPUT_LINES {
                    // Keep draining so the child never blocks on a full pipe.
                    continue;
                }
                emitted += 1;
                let line = if emitted == MAX_TERMINAL_OUTPUT_LINES {
                    format!("… output truncated after {MAX_TERMINAL_OUTPUT_LINES} lines")
                } else {
                    String::from_utf8_lossy(&buffer)
                        .trim_end_matches(['\r', '\n'])
                        .to_owned()
                };
                let _ = app.emit(
                    "terminal://output",
                    &TerminalOutputPayload {
                        session_id: session_id.clone(),
                        run_id: run_id.clone(),
                        stream,
                        line: Some(line),
                        exit_code: None,
                        cwd: cwd.clone(),
                    },
                );
            }
        }
    }
}

#[tauri::command]
pub async fn codex_connect(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    working_directory: Option<PathBuf>,
    task_id: Option<TaskId>,
) -> CommandResult<()> {
    let statuses = tauri::async_runtime::spawn_blocking(discover_providers)
        .await
        .map_err(|_| worker_error())?;
    let executable =
        provider_executable(&statuses, ProviderKind::Codex).ok_or_else(|| CommandError {
            code: "provider-unavailable",
            message: "Codex CLI is not installed".into(),
        })?;
    let client = adapter_codex::CodexClient::spawn(CodexLaunchOptions {
        executable,
        working_directory,
        client_version: env!("CARGO_PKG_VERSION").into(),
    })
    .await
    .map_err(CommandError::from)?;
    let runtime = CodexRuntime {
        client,
        process_id: uuid::Uuid::new_v4().to_string(),
        binding: Arc::new(std::sync::Mutex::new(None)),
        context_primer: Arc::new(std::sync::Mutex::new(None)),
    };
    if let Some(task_id) = task_id {
        let store = Arc::clone(&state.store);
        let process_id = runtime.process_id.clone();
        let binding = tauri::async_runtime::spawn_blocking(move || {
            store.create_runtime_binding(task_id, &process_id, ProviderKind::Codex)
        })
        .await
        .map_err(|_| worker_error())?
        .map_err(CommandError::from)?;
        *runtime.binding.lock().expect("binding lock") = Some(binding);
    }
    spawn_projection_pump(app, Arc::clone(&state.store), runtime.clone());
    // Snapshot subscription quota once per connect; rolling
    // `account/rateLimits/updated` notifications keep it fresh afterwards.
    {
        let client = runtime.client.clone();
        let store = Arc::clone(&state.store);
        tauri::async_runtime::spawn(async move {
            if let Ok(response) = client.read_rate_limits().await {
                store_provider_quota(&store, ProviderKind::Codex, &response);
            }
        });
    }
    let previous = state.codex.lock().await.replace(runtime);
    if let Some(previous) = previous {
        let _ = state.store.expire_process_approvals(&previous.process_id);
        let _ = previous.client.shutdown().await;
    }
    Ok(())
}

/// Forwards adapter events through the reducer into SQLite, then emits the
/// persisted, sequenced projection to the renderer. Events that arrive before
/// a task/thread binding exists cannot be attributed and are dropped.
pub(crate) fn spawn_projection_pump(
    app: AppHandle<tauri::Wry>,
    store: Arc<LocalStore>,
    runtime: CodexRuntime,
) {
    let mut receiver = runtime.client.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            let event = match receiver.recv().await {
                Ok(event) => event,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    pump_connection_event(
                        &app,
                        &store,
                        &runtime,
                        "client/receiverLagged",
                        ConnectionState::Gap,
                        Some("event stream lagged; recovery required"),
                    );
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            let binding = runtime.binding.lock().expect("binding lock").clone();
            match event {
                CodexEvent::Notification { method, params } => {
                    // Account-level quota has no thread binding and would be
                    // rejected by the task-scoped reducer; persist it directly.
                    if method == "account/rateLimits/updated" {
                        store_provider_quota(&store, ProviderKind::Codex, &params);
                        continue;
                    }
                    pump_provider_event(&app, &store, binding.as_ref(), method, params, None);
                }
                CodexEvent::ServerRequest { id, method, params } => {
                    let request_id = transport_from_server_request(&id);
                    pump_provider_event(
                        &app,
                        &store,
                        binding.as_ref(),
                        method,
                        params,
                        Some(request_id),
                    );
                }
                CodexEvent::ProtocolViolation { code } => {
                    pump_connection_event(
                        &app,
                        &store,
                        &runtime,
                        "client/protocolViolation",
                        ConnectionState::Gap,
                        Some(&code),
                    );
                }
                CodexEvent::StderrActivity => {}
                CodexEvent::Exited => {
                    let _ = store.expire_process_approvals(&runtime.process_id);
                    pump_connection_event(
                        &app,
                        &store,
                        &runtime,
                        "provider/exited",
                        ConnectionState::Disconnected,
                        Some("Codex app-server exited"),
                    );
                    break;
                }
            }
        }
    });
}

fn pump_provider_event(
    app: &AppHandle<tauri::Wry>,
    store: &LocalStore,
    binding: Option<&RuntimeBinding>,
    method: String,
    params: Value,
    request_id: Option<TransportRequestId>,
) {
    let Some(binding) = binding else { return };
    let reduced = match reduce_provider_event(ProviderEventInput {
        method,
        params,
        request_id,
        occurred_at: Utc::now(),
    }) {
        Ok(Some(reduced)) => reduced,
        Ok(None) => return,
        Err(_) => reduce_connection_event(
            "client/reducerRejected",
            binding.thread_id.as_deref().unwrap_or("unknown"),
            ConnectionState::Gap,
            Some("provider event was rejected; reconciliation required"),
            Utc::now(),
        ),
    };
    if let Ok(event) = store.apply_reduced_event(binding, &reduced) {
        let _ = app.emit("runtime://projection", &event);
    }
}

fn pump_connection_event(
    app: &AppHandle<tauri::Wry>,
    store: &LocalStore,
    runtime: &CodexRuntime,
    method: &str,
    connection: ConnectionState,
    reason: Option<&str>,
) {
    let Some(binding) = runtime.binding.lock().expect("binding lock").clone() else {
        return;
    };
    let Some(thread_id) = binding.thread_id.clone() else {
        return;
    };
    let reduced = reduce_connection_event(method, &thread_id, connection, reason, Utc::now());
    if let Ok(event) = store.apply_reduced_event(&binding, &reduced) {
        let _ = app.emit("runtime://projection", &event);
    }
}

fn transport_from_server_request(id: &ServerRequestId) -> TransportRequestId {
    match id.to_protocol_value() {
        Value::Number(number) => TransportRequestId::Number(number),
        Value::String(text) => TransportRequestId::String(text),
        _ => unreachable!("server request ids are numbers or strings"),
    }
}

fn server_request_from_transport(id: &TransportRequestId) -> Result<ServerRequestId, CommandError> {
    let value = match id {
        TransportRequestId::Number(number) => Value::Number(number.clone()),
        TransportRequestId::String(text) => Value::String(text.clone()),
    };
    ServerRequestId::from_protocol_value(&value).map_err(CommandError::from)
}

#[tauri::command]
pub async fn codex_disconnect(state: State<'_, AppState>) -> CommandResult<()> {
    if let Some(runtime) = state.codex.lock().await.take() {
        let _ = state.store.expire_process_approvals(&runtime.process_id);
        runtime
            .client
            .shutdown()
            .await
            .map_err(CommandError::from)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn codex_list_models(
    state: State<'_, AppState>,
    include_hidden: bool,
) -> CommandResult<Value> {
    codex_client(&state)
        .await?
        .list_models(include_hidden)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn codex_list_threads(
    state: State<'_, AppState>,
    cursor: Option<String>,
    limit: u32,
) -> CommandResult<Value> {
    codex_client(&state)
        .await?
        .list_threads(cursor, limit)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn codex_read_thread(
    state: State<'_, AppState>,
    thread_id: String,
    include_turns: bool,
) -> CommandResult<Value> {
    codex_client(&state)
        .await?
        .read_thread(&thread_id, include_turns)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn codex_start_thread(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
    cwd: PathBuf,
    model: Option<String>,
    effort: Option<String>,
    permission: Option<String>,
) -> CommandResult<Value> {
    state.store.get_task(task_id).map_err(CommandError::from)?;
    // Map the UI permission profile onto Codex's approval-policy/sandbox
    // pair. Codex prompts through its own approval requests, so "ask" means
    // prompt for everything and "full access" means never prompt, unsandboxed.
    let (approval_policy, sandbox) = match permission.as_deref() {
        None | Some("project-write") => ("on-request", "workspace-write"),
        Some("read-only") => ("on-request", "read-only"),
        Some("ask") => ("untrusted", "workspace-write"),
        Some("full-access") => ("never", "danger-full-access"),
        Some(_) => {
            return Err(CommandError {
                code: "invalid-input",
                message: "unknown permission profile".into(),
            });
        }
    };
    let runtime = codex_runtime(&state).await?;
    let response = runtime
        .client
        .start_thread_with_policies(
            &cwd,
            model.as_deref(),
            effort.as_deref(),
            approval_policy,
            sandbox,
        )
        .await
        .map_err(CommandError::from)?;
    if let Some(thread_id) = extract_thread_id(&response) {
        bind_thread(&state, &runtime, task_id, &thread_id).await?;
        queue_context_primer(&state, task_id, &runtime.context_primer).await;
        pump_connection_event(
            &app,
            &state.store,
            &runtime,
            "client/threadBound",
            ConnectionState::Connected,
            None,
        );
        reconcile_thread_response(&app, &state.store, &runtime, &response);
    }
    Ok(response)
}

const CONTEXT_PRIMER_BYTES: usize = 6 * 1024;

/// Queue the task's conversation digest for injection into the first turn of
/// a brand-new provider session, so switching providers (or losing a thread)
/// carries the conversation across instead of starting blank.
async fn queue_context_primer(
    state: &State<'_, AppState>,
    task_id: TaskId,
    primer: &Arc<std::sync::Mutex<Option<String>>>,
) {
    let store = Arc::clone(&state.store);
    let digest = tauri::async_runtime::spawn_blocking(move || {
        store.task_conversation_digest(task_id, CONTEXT_PRIMER_BYTES)
    })
    .await;
    if let Ok(Ok(Some(digest))) = digest {
        *primer.lock().expect("primer lock") = Some(digest);
    }
}

fn apply_context_primer(
    primer: &Arc<std::sync::Mutex<Option<String>>>,
    prompt: &str,
) -> Option<String> {
    let digest = primer.lock().expect("primer lock").take()?;
    Some(format!(
        "<conversation-context>\nEarlier conversation in this task (possibly from another assistant session). Treat it as prior chat history, not as part of the new request:\n\n{digest}\n</conversation-context>\n\n{prompt}"
    ))
}

#[tauri::command]
pub async fn codex_resume_thread(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
    thread_id: String,
) -> CommandResult<Value> {
    state.store.get_task(task_id).map_err(CommandError::from)?;
    let runtime = codex_runtime(&state).await?;
    let response = runtime
        .client
        .resume_thread(&thread_id)
        .await
        .map_err(CommandError::from)?;
    bind_thread(&state, &runtime, task_id, &thread_id).await?;
    pump_connection_event(
        &app,
        &state.store,
        &runtime,
        "client/threadResumed",
        ConnectionState::Connected,
        None,
    );
    reconcile_thread_response(&app, &state.store, &runtime, &response);
    Ok(response)
}

/// Persist the task-to-thread binding and hand it to the projection pump so
/// subsequent provider events become attributable, durable projections.
async fn bind_thread(
    state: &State<'_, AppState>,
    runtime: &CodexRuntime,
    task_id: TaskId,
    thread_id: &str,
) -> CommandResult<()> {
    let store = Arc::clone(&state.store);
    let process_id = runtime.process_id.clone();
    let thread = thread_id.to_owned();
    let current = runtime.binding.lock().expect("binding lock").clone();
    let binding = tauri::async_runtime::spawn_blocking(move || {
        let binding = match current {
            Some(binding) if binding.task_id == task_id => binding,
            Some(_) => {
                return Err(IntegratorError::Unauthorized(
                    "Codex runtime is already bound to another task".into(),
                ));
            }
            None => store.create_runtime_binding(task_id, &process_id, ProviderKind::Codex)?,
        };
        store.attach_provider_thread(&binding, &thread)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(CommandError::from)?;
    *runtime.binding.lock().expect("binding lock") = Some(binding);
    Ok(())
}

#[tauri::command]
pub async fn codex_start_turn(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    thread_id: String,
    prompt: String,
) -> CommandResult<Value> {
    let runtime = codex_runtime(&state).await?;
    let wire_prompt =
        apply_context_primer(&runtime.context_primer, &prompt).unwrap_or_else(|| prompt.clone());
    let response = runtime
        .client
        .start_turn(&thread_id, &wire_prompt)
        .await
        .map_err(CommandError::from)?;
    reconcile_turn_response(&app, &state.store, &runtime, &thread_id, &response);
    Ok(response)
}

#[tauri::command]
pub async fn codex_interrupt_turn(
    state: State<'_, AppState>,
    thread_id: String,
    turn_id: String,
) -> CommandResult<Value> {
    codex_client(&state)
        .await?
        .interrupt_turn(&thread_id, &turn_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn task_snapshot(
    state: State<'_, AppState>,
    task_id: TaskId,
) -> CommandResult<TaskSnapshot> {
    let store = Arc::clone(&state.store);
    tauri::async_runtime::spawn_blocking(move || store.task_snapshot(task_id))
        .await
        .map_err(|_| worker_error())?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn codex_respond_approval(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
    approval_id: String,
    decision: ApprovalDecision,
) -> CommandResult<ApprovalProjection> {
    let store = Arc::clone(&state.store);
    let stored_approval_id = approval_id.clone();
    let stored_decision = decision.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        store.prepare_approval_response(task_id, &stored_approval_id, stored_decision)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(CommandError::from)?;
    let _ = app.emit("runtime://projection", &prepared.event);

    let approval = match &prepared.event.projection {
        RuntimeProjection::ApprovalChanged { approval } => approval.clone(),
        _ => unreachable!("prepared approval emits an approval projection"),
    };
    // Route the wire response to whichever live process issued the request.
    let acp = state.acp.lock().await.clone();
    let structured = state.structured.lock().await.clone();
    let result = if let Some(acp) = acp.filter(|runtime| runtime.process_id == prepared.process_id)
    {
        let request_id = acp_request_from_transport(&prepared.request_id)?;
        let outcome = acp_permission_outcome(&acp, &prepared.request_id, decision);
        acp.client
            .respond_to_server_request(&request_id, outcome)
            .await
    } else if let Some(structured) =
        structured.filter(|runtime| runtime.process_id == prepared.process_id)
    {
        let request_id = match &prepared.request_id {
            TransportRequestId::String(text) => text.clone(),
            TransportRequestId::Number(number) => number.to_string(),
        };
        let pending = structured
            .permission_requests
            .lock()
            .expect("permission lock")
            .remove(&request_id);
        let response = structured_permission_response(decision, pending);
        structured
            .client
            .respond_permission(&request_id, response)
            .await
    } else {
        let runtime = codex_runtime(&state).await?;
        if runtime.process_id != prepared.process_id {
            return Err(CommandError {
                code: "stale-approval",
                message: "approval belongs to an expired provider process".into(),
            });
        }
        let request_id = server_request_from_transport(&prepared.request_id)?;
        runtime
            .client
            .respond_to_server_request(
                &request_id,
                serde_json::json!({ "decision": approval.decision.as_ref().map(ApprovalDecision::as_protocol_str) }),
            )
            .await
    };
    if let Err(error) = result {
        let store = Arc::clone(&state.store);
        if let Ok(Ok(event)) = tauri::async_runtime::spawn_blocking(move || {
            store.mark_approval_response_failed(&approval_id)
        })
        .await
        {
            let _ = app.emit("runtime://projection", event);
        }
        return Err(CommandError::from(error));
    }
    Ok(approval)
}

#[tauri::command]
pub async fn codex_stop_turn(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
) -> CommandResult<StopRequestResult> {
    let store = Arc::clone(&state.store);
    let persisted = tauri::async_runtime::spawn_blocking(move || store.request_stop(task_id))
        .await
        .map_err(|_| worker_error())?
        .map_err(CommandError::from)?;
    if let Some(event) = &persisted.event {
        let _ = app.emit("runtime://projection", event);
    }
    if !persisted.result.already_requested && !persisted.result.settled {
        // The persisted stop is provider-neutral; route the wire-level
        // interrupt to whichever runtime owns this task.
        let routed: Result<(), CommandError> = async {
            let acp = state.acp.lock().await.clone();
            let acp_session = acp.as_ref().and_then(|runtime| {
                runtime
                    .binding
                    .lock()
                    .expect("binding lock")
                    .clone()
                    .filter(|binding| binding.task_id == task_id)
                    .and_then(|binding| binding.thread_id)
            });
            if let (Some(runtime), Some(session_id)) = (acp, acp_session) {
                runtime
                    .client
                    .cancel(&session_id)
                    .await
                    .map_err(CommandError::from)?;
            } else if let Some(runtime) = state.structured.lock().await.clone().filter(|runtime| {
                runtime
                    .binding
                    .lock()
                    .expect("binding lock")
                    .as_ref()
                    .is_some_and(|binding| binding.task_id == task_id)
            }) {
                let turn_id = runtime
                    .current_turn
                    .lock()
                    .expect("turn lock")
                    .clone()
                    .ok_or_else(|| CommandError {
                        code: "provider-disconnected",
                        message: "structured provider turn is no longer active".into(),
                    })?;
                runtime
                    .client
                    .cancel(&turn_id)
                    .await
                    .map_err(CommandError::from)?;
            } else {
                let runtime = codex_runtime(&state).await?;
                let binding = runtime.binding.lock().expect("binding lock").clone();
                let thread_id = binding
                    .filter(|binding| binding.task_id == task_id)
                    .and_then(|binding| binding.thread_id)
                    .ok_or_else(|| CommandError {
                        code: "provider-disconnected",
                        message: "active task is not connected to a provider".into(),
                    })?;
                runtime
                    .client
                    .interrupt_turn(&thread_id, &persisted.result.turn_id)
                    .await
                    .map_err(CommandError::from)?;
            }
            Ok(())
        }
        .await;
        if let Err(error) = routed {
            // The provider never received the interrupt (dead or rebound
            // session). Settle the turn locally so the UI leaves the
            // running state instead of surfacing a not-found error.
            let store = Arc::clone(&state.store);
            let settled =
                tauri::async_runtime::spawn_blocking(move || store.settle_stopped_turn(task_id))
                    .await
                    .map_err(|_| worker_error())?
                    .map_err(CommandError::from)?;
            let Some(event) = settled else {
                return Err(error);
            };
            let _ = app.emit("runtime://projection", &event);
            let mut result = persisted.result;
            result.settled = true;
            return Ok(result);
        }
    }
    Ok(persisted.result)
}

#[tauri::command]
pub async fn acp_connect(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    provider: ProviderKind,
    working_directory: Option<PathBuf>,
) -> CommandResult<()> {
    let arguments = acp_launch_arguments(&provider)?;
    let statuses = tauri::async_runtime::spawn_blocking(discover_providers)
        .await
        .map_err(|_| worker_error())?;
    let executable =
        provider_executable(&statuses, provider.clone()).ok_or_else(|| CommandError {
            code: "provider-unavailable",
            message: format!("{} CLI is not installed", provider.as_str()),
        })?;
    let client = adapter_acp::AcpClient::spawn(adapter_acp::AcpLaunchOptions {
        executable,
        arguments,
        working_directory,
        client_version: env!("CARGO_PKG_VERSION").into(),
    })
    .await
    .map_err(CommandError::from)?;
    let runtime = AcpRuntime {
        client,
        provider,
        process_id: uuid::Uuid::new_v4().to_string(),
        binding: Arc::new(std::sync::Mutex::new(None)),
        current_turn: Arc::new(std::sync::Mutex::new(None)),
        permission_options: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        context_primer: Arc::new(std::sync::Mutex::new(None)),
        delegation_preamble: Arc::new(std::sync::Mutex::new(None)),
    };
    spawn_acp_pump(app, Arc::clone(&state.store), runtime.clone());
    let previous = state.acp.lock().await.replace(runtime);
    if let Some(previous) = previous {
        let _ = state.store.expire_process_approvals(&previous.process_id);
        let _ = previous.client.shutdown().await;
    }
    Ok(())
}

fn acp_launch_arguments(provider: &ProviderKind) -> CommandResult<Vec<String>> {
    Ok(match provider {
        ProviderKind::Cursor => vec!["acp".into()],
        _ => {
            return Err(CommandError {
                code: "provider-unavailable",
                message: format!(
                    "{} does not expose a certified ACP launch route",
                    provider.as_str()
                ),
            });
        }
    })
}

#[tauri::command]
pub async fn acp_start_session(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
    cwd: PathBuf,
    delegation: Option<String>,
) -> CommandResult<Value> {
    state.store.get_task(task_id).map_err(CommandError::from)?;
    let runtime = acp_runtime(&state).await?;
    let provider = runtime.provider.clone();
    let provider_name = provider.as_str().to_owned();
    // Delegation broker injection: ACP's `session/new` carries MCP servers
    // natively. The tool preamble is queued one-shot for the first turn.
    let mut mcp_servers = Vec::new();
    if let Some(mode) = delegation.as_deref().filter(|mode| *mode != "off") {
        let broker = state.broker.lock().expect("broker lock").clone();
        if let Some(info) = broker {
            if let Ok(entry) = crate::delegation::acp_mcp_server_entry(
                &info,
                "orchestrator",
                &task_id.to_string(),
                mode,
            ) {
                mcp_servers.push(entry);
                *runtime.delegation_preamble.lock().expect("preamble lock") =
                    Some(crate::delegation::orchestrator_preamble(&state.store, mode));
            }
        }
    }
    let response = runtime
        .client
        .new_session(&cwd, mcp_servers)
        .await
        .map_err(CommandError::from)?;
    let session_id = response
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| CommandError {
            code: "provider-protocol",
            message: format!("{provider_name} did not return a session identifier"),
        })?
        .to_owned();
    let store = Arc::clone(&state.store);
    let process_id = runtime.process_id.clone();
    let session = session_id.clone();
    let current = runtime.binding.lock().expect("binding lock").clone();
    let binding = tauri::async_runtime::spawn_blocking(move || {
        let binding = match current {
            Some(binding) if binding.task_id == task_id => binding,
            Some(_) => {
                return Err(IntegratorError::Unauthorized(format!(
                    "{provider_name} runtime is already bound to another task"
                )));
            }
            None => store.create_runtime_binding(task_id, &process_id, provider)?,
        };
        store.attach_provider_thread(&binding, &session)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(CommandError::from)?;
    *runtime.binding.lock().expect("binding lock") = Some(binding.clone());
    let connected = reduce_connection_event(
        "client/acp/connected",
        &session_id,
        ConnectionState::Connected,
        None,
        Utc::now(),
    );
    apply_and_emit(&app, &state.store, &binding, &connected);
    queue_context_primer(&state, task_id, &runtime.context_primer).await;
    Ok(response)
}

#[tauri::command]
pub async fn acp_send_turn(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
    prompt: String,
    delegation: Option<String>,
) -> CommandResult<Value> {
    let runtime = acp_runtime(&state).await?;
    let provider_name = runtime.provider.as_str();
    let binding = runtime
        .binding
        .lock()
        .expect("binding lock")
        .clone()
        .filter(|binding| binding.task_id == task_id)
        .ok_or_else(|| CommandError {
            code: "provider-disconnected",
            message: format!("{provider_name} session is not bound to this task"),
        })?;
    let session_id = binding.thread_id.clone().ok_or_else(|| CommandError {
        code: "provider-disconnected",
        message: format!("{provider_name} session identity is missing"),
    })?;
    let turn_id = uuid::Uuid::new_v4().to_string();
    *runtime.current_turn.lock().expect("turn lock") = Some(turn_id.clone());
    let started_at = Utc::now();

    // Persist the user message and the in-progress turn before prompting so a
    // restart mid-turn can reconstruct what was asked.
    let user_item = ReducedProviderEvent {
        method: "client/acp/userMessage".into(),
        thread_id: session_id.clone(),
        turn_id: Some(turn_id.clone()),
        audit_json: "{}".into(),
        audit_truncated: false,
        mutation: ProjectionMutation::NeutralItem(integrator_core::ItemProjection {
            id: format!("acp:{session_id}:{turn_id}:user"),
            provider_item_id: format!("{turn_id}-user"),
            kind: integrator_core::ItemKind::UserMessage,
            status: integrator_core::ItemStatus::Completed,
            title: None,
            body: Some(integrator_runtime::redact_and_bound(&prompt, 2 * 1024 * 1024).0),
            command: None,
            cwd: None,
            output: None,
            exit_code: None,
            file_changes: None,
            mcp_server: None,
            mcp_tool: None,
            tool_input: None,
            truncated: false,
            updated_at: started_at,
        }),
        occurred_at: started_at,
    };
    apply_and_emit(&app, &state.store, &binding, &user_item);
    let turn_started = ReducedProviderEvent {
        method: "client/acp/turnStarted".into(),
        thread_id: session_id.clone(),
        turn_id: Some(turn_id.clone()),
        audit_json: "{}".into(),
        audit_truncated: false,
        mutation: ProjectionMutation::Turn(acp_turn_projection(
            &turn_id,
            TurnStatus::InProgress,
            None,
            started_at,
            started_at,
        )),
        occurred_at: started_at,
    };
    apply_and_emit(&app, &state.store, &binding, &turn_started);

    // session/prompt resolves when the turn ends; finish the turn projection
    // from a background task so this command returns immediately. The primer
    // rides only on the wire prompt — the persisted user item above keeps the
    // prompt exactly as the user typed it.
    let mut wire_prompt =
        apply_context_primer(&runtime.context_primer, &prompt).unwrap_or_else(|| prompt.clone());
    if delegation.as_deref().is_some_and(|mode| mode != "off") {
        let mut preface = runtime
            .delegation_preamble
            .lock()
            .expect("preamble lock")
            .take()
            .unwrap_or_default();
        if let Some(updates) = crate::delegation::pending_updates_block(&state.store, task_id) {
            preface.push_str(&updates);
        }
        if !preface.is_empty() {
            wire_prompt = format!("{preface}{wire_prompt}");
        }
    }
    let client = runtime.client.clone();
    let current_turn = Arc::clone(&runtime.current_turn);
    let store = Arc::clone(&state.store);
    let emit_app = app.clone();
    let finished_turn = turn_id.clone();
    let finished_session = session_id.clone();
    let finished_binding = binding.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = client.prompt(&finished_session, &wire_prompt).await;
        let now = Utc::now();
        let (status, error) = match &outcome {
            Ok(response) => match adapter_acp::StopReason::from_protocol(response) {
                adapter_acp::StopReason::Cancelled => (TurnStatus::Interrupted, None),
                adapter_acp::StopReason::Refusal => (
                    TurnStatus::Failed,
                    Some("The agent refused the turn".into()),
                ),
                _ => (TurnStatus::Completed, None),
            },
            Err(error) => (TurnStatus::Failed, Some(error.to_string())),
        };
        let mut turn = acp_turn_projection(&finished_turn, status, error, started_at, now);
        turn.stop_requested = false;
        let reduced = ReducedProviderEvent {
            method: "client/acp/turnFinished".into(),
            thread_id: finished_session,
            turn_id: Some(finished_turn.clone()),
            audit_json: "{}".into(),
            audit_truncated: false,
            mutation: ProjectionMutation::Turn(turn),
            occurred_at: now,
        };
        apply_and_emit(&emit_app, &store, &finished_binding, &reduced);
        let mut current = current_turn.lock().expect("turn lock");
        if current.as_deref() == Some(finished_turn.as_str()) {
            *current = None;
        }
    });
    Ok(serde_json::json!({ "turnId": turn_id }))
}

/// Resolve the ACP session bound to `task_id`, or fail as disconnected.
fn acp_bound_session(runtime: &AcpRuntime, task_id: TaskId) -> Result<String, CommandError> {
    runtime
        .binding
        .lock()
        .expect("binding lock")
        .clone()
        .filter(|binding| binding.task_id == task_id)
        .and_then(|binding| binding.thread_id)
        .ok_or_else(|| CommandError {
            code: "provider-disconnected",
            message: format!(
                "{} session is not bound to this task",
                runtime.provider.as_str()
            ),
        })
}

#[tauri::command]
pub async fn acp_set_config_option(
    state: State<'_, AppState>,
    task_id: TaskId,
    config_id: String,
    value: String,
) -> CommandResult<Value> {
    let runtime = acp_runtime(&state).await?;
    let session_id = acp_bound_session(&runtime, task_id)?;
    runtime
        .client
        .set_config_option(&session_id, &config_id, &value)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn acp_list_cursor_models(state: State<'_, AppState>) -> CommandResult<Value> {
    let runtime = acp_runtime(&state).await?;
    if runtime.provider != ProviderKind::Cursor {
        return Err(CommandError {
            code: "invalid-input",
            message: "cursor/list_available_models is a Cursor-only extension".into(),
        });
    }
    runtime
        .client
        .list_cursor_models()
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn structured_cli_start_turn(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    task_id: TaskId,
    provider: ProviderKind,
    cwd: PathBuf,
    model: Option<String>,
    effort: Option<String>,
    permission: String,
    prompt: String,
    delegation: Option<String>,
) -> CommandResult<Value> {
    let task = state.store.get_task(task_id).map_err(CommandError::from)?;
    let (_, repository) = authorized_git(&state, cwd.clone()).await?;
    let expected = task
        .worktree_path
        .as_ref()
        .or(task.repository_path.as_ref())
        .ok_or_else(|| CommandError {
            code: "invalid-input",
            message: "task has no explicit repository/worktree identity".into(),
        })?;
    let expected = dunce::canonicalize(expected).map_err(|_| CommandError {
        code: "invalid-input",
        message: "task repository/worktree is unavailable".into(),
    })?;
    if repository.root != expected {
        return Err(CommandError {
            code: "unauthorized",
            message: "provider working directory does not match this task's repository/worktree"
                .into(),
        });
    }
    let structured_provider = structured_provider(&provider)?;
    let permission_mode = match permission.as_str() {
        "read-only" => StructuredPermissionMode::ReadOnly,
        "project-write" => StructuredPermissionMode::AcceptEdits,
        // Claude routes prompts over the stdio control channel, so "ask"
        // yields real approval popups. agy's print mode has no channel to
        // answer its request-review prompts, so "ask" cannot be honored there.
        "ask" => match structured_provider {
            StructuredCliProvider::Claude => StructuredPermissionMode::Prompt,
            StructuredCliProvider::Antigravity => {
                return Err(CommandError {
                    code: "invalid-input",
                    message: "the Antigravity CLI cannot prompt for approvals in this mode; \
                              choose Read only, Project write, or Full access"
                        .into(),
                });
            }
        },
        // The user explicitly picked the "Full access" profile; map it onto
        // each vendor's skip-approvals flag.
        "full-access" => StructuredPermissionMode::BypassPermissions,
        _ => {
            return Err(CommandError {
                code: "invalid-input",
                message: "unknown permission profile".into(),
            });
        }
    };
    let statuses = tauri::async_runtime::spawn_blocking(discover_providers)
        .await
        .map_err(|_| worker_error())?;
    let executable =
        provider_executable(&statuses, provider.clone()).ok_or_else(|| CommandError {
            code: "provider-unavailable",
            message: format!("{} CLI is not installed", provider.as_str()),
        })?;

    // Only one structured provider process may own the local control route.
    // Cancel the previous process before spawning its replacement.
    if let Some(previous) = state.structured.lock().await.take() {
        let turn = { previous.current_turn.lock().expect("turn lock").clone() };
        if let Some(turn) = turn {
            let _ = previous.client.cancel(&turn).await;
        }
        let _ = state.store.expire_process_approvals(&previous.process_id);
    }

    let digest_store = Arc::clone(&state.store);
    let digest = tauri::async_runtime::spawn_blocking(move || {
        digest_store.task_conversation_digest(task_id, CONTEXT_PRIMER_BYTES)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(CommandError::from)?;
    let mut wire_prompt = match digest {
        Some(digest) => format!(
            "<conversation-context>\nEarlier conversation in this task (possibly from another assistant session). Treat it as prior chat history, not as part of the new request:\n\n{digest}\n</conversation-context>\n\n{prompt}"
        ),
        None => prompt.clone(),
    };

    // Delegation broker injection: each structured turn is a fresh provider
    // session, so the tool preamble and any pending subagent updates ride on
    // every wire prompt while delegation is active.
    let delegation_mode = delegation.filter(|mode| mode != "off");
    let mut mcp_config_path = None;
    if let Some(mode) = delegation_mode.as_deref() {
        let store = Arc::clone(&state.store);
        let mut preface = crate::delegation::orchestrator_preamble(&store, mode);
        if let Some(updates) = crate::delegation::pending_updates_block(&store, task_id) {
            preface.push_str(&updates);
        }
        wire_prompt = format!("{preface}{wire_prompt}");
        if matches!(structured_provider, StructuredCliProvider::Claude) {
            let broker = state.broker.lock().expect("broker lock").clone();
            if let Some(info) = broker {
                mcp_config_path = crate::delegation::write_mcp_config(
                    &app,
                    &info,
                    "orchestrator",
                    &task_id.to_string(),
                    mode,
                )
                .ok();
            }
        }
    }

    let client = integrator_runtime::StructuredCliClient::new();
    let process_id = uuid::Uuid::new_v4().to_string();
    // Thread ids must pass the projection store's identity charset
    // (alphanumeric plus `-`, `_`, `.`), so no `:` separators here.
    let thread_id = format!("structured.{}.{}", provider.as_str(), uuid::Uuid::new_v4());
    let store = Arc::clone(&state.store);
    let stored_process = process_id.clone();
    let stored_thread = thread_id.clone();
    let stored_provider = provider.clone();
    let binding = tauri::async_runtime::spawn_blocking(move || {
        let binding = store.create_runtime_binding(task_id, &stored_process, stored_provider)?;
        store.attach_provider_thread(&binding, &stored_thread)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(CommandError::from)?;
    let runtime = StructuredRuntime {
        client: client.clone(),
        process_id,
        binding: Arc::new(std::sync::Mutex::new(Some(binding.clone()))),
        current_turn: Arc::new(std::sync::Mutex::new(None)),
        last_diagnostic: Arc::new(std::sync::Mutex::new(None)),
        permission_requests: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
    };
    spawn_structured_cli_pump(app.clone(), Arc::clone(&state.store), runtime.clone());
    let turn_id = client
        .start_turn(
            StructuredCliLaunchOptions {
                provider: structured_provider,
                executable,
                working_directory: cwd,
                model: model.filter(|value| value != "Provider default"),
                effort: effort.filter(|value| !value.is_empty()),
                resume_session_id: None,
                permission_mode,
                mcp_config_path,
            },
            wire_prompt,
        )
        .await
        .map_err(CommandError::from)?;
    *runtime.current_turn.lock().expect("turn lock") = Some(turn_id.clone());
    let now = Utc::now();
    apply_and_emit(
        &app,
        &state.store,
        &binding,
        &ReducedProviderEvent {
            method: "client/structured/userMessage".into(),
            thread_id: thread_id.clone(),
            turn_id: Some(turn_id.clone()),
            audit_json: "{}".into(),
            audit_truncated: false,
            mutation: ProjectionMutation::NeutralItem(integrator_core::ItemProjection {
                id: format!("structured:{thread_id}:{turn_id}:user"),
                provider_item_id: format!("{turn_id}-user"),
                kind: integrator_core::ItemKind::UserMessage,
                status: integrator_core::ItemStatus::Completed,
                title: None,
                body: Some(integrator_runtime::redact_and_bound(&prompt, 2 * 1024 * 1024).0),
                command: None,
                cwd: None,
                output: None,
                exit_code: None,
                file_changes: None,
                mcp_server: None,
                mcp_tool: None,
                tool_input: None,
                truncated: false,
                updated_at: now,
            }),
            occurred_at: now,
        },
    );
    apply_and_emit(
        &app,
        &state.store,
        &binding,
        &ReducedProviderEvent {
            method: "client/structured/turnStarted".into(),
            thread_id,
            turn_id: Some(turn_id.clone()),
            audit_json: "{}".into(),
            audit_truncated: false,
            mutation: ProjectionMutation::Turn(acp_turn_projection(
                &turn_id,
                TurnStatus::InProgress,
                None,
                now,
                now,
            )),
            occurred_at: now,
        },
    );
    state.structured.lock().await.replace(runtime);
    Ok(serde_json::json!({ "turnId": turn_id }))
}

fn structured_provider(provider: &ProviderKind) -> CommandResult<StructuredCliProvider> {
    match provider {
        ProviderKind::Claude => Ok(StructuredCliProvider::Claude),
        ProviderKind::Antigravity => Ok(StructuredCliProvider::Antigravity),
        _ => Err(CommandError {
            code: "provider-unavailable",
            message: format!("{} has no structured CLI route", provider.as_str()),
        }),
    }
}

pub(crate) fn spawn_structured_cli_pump(
    app: AppHandle<tauri::Wry>,
    store: Arc<LocalStore>,
    runtime: StructuredRuntime,
) {
    let mut receiver = runtime.client.subscribe();
    tauri::async_runtime::spawn(async move {
        while let Ok(event) = receiver.recv().await {
            let Some(binding) = runtime.binding.lock().expect("binding lock").clone() else {
                continue;
            };
            let Some(thread_id) = binding.thread_id.clone() else {
                continue;
            };
            let now = Utc::now();
            let mutation = match event.event {
                StructuredCliEventKind::Init { .. } => None,
                StructuredCliEventKind::Text { text, delta } => Some(if delta {
                    ProjectionMutation::AppendItem {
                        provider_item_id: format!("{}-agent", event.turn_id),
                        item_kind: integrator_core::ItemKind::AgentMessage,
                        field: integrator_runtime::ItemTextField::Body,
                        delta: integrator_runtime::redact_and_bound(&text, 2 * 1024 * 1024).0,
                        updated_at: now,
                    }
                } else {
                    ProjectionMutation::ReplaceItem(structured_item(
                        &thread_id,
                        &event.turn_id,
                        "agent",
                        integrator_core::ItemKind::AgentMessage,
                        None,
                        Some(text),
                        None,
                        integrator_core::ItemStatus::Completed,
                        now,
                    ))
                }),
                StructuredCliEventKind::ToolUse { id, name, input: _ } => {
                    Some(ProjectionMutation::ReplaceItem(structured_item(
                        &thread_id,
                        &event.turn_id,
                        &id,
                        integrator_core::ItemKind::McpTool,
                        Some(name),
                        None,
                        None,
                        integrator_core::ItemStatus::InProgress,
                        now,
                    )))
                }
                StructuredCliEventKind::ToolResult {
                    id,
                    is_error,
                    content: _,
                } => Some(ProjectionMutation::ReplaceItem(structured_item(
                    &thread_id,
                    &event.turn_id,
                    &id,
                    integrator_core::ItemKind::McpTool,
                    Some("Tool result".into()),
                    None,
                    None,
                    if is_error {
                        integrator_core::ItemStatus::Failed
                    } else {
                        integrator_core::ItemStatus::Completed
                    },
                    now,
                ))),
                StructuredCliEventKind::Result {
                    success,
                    message,
                    usage,
                } => {
                    // Per-turn usage accumulates onto the task projection so
                    // the per-provider summary reflects vendor-reported
                    // numbers instead of staying "unavailable".
                    if let Some(delta) = structured_usage_delta(&usage) {
                        apply_and_emit(
                            &app,
                            &store,
                            &binding,
                            &ReducedProviderEvent {
                                method: "provider/structured/event".into(),
                                thread_id: thread_id.clone(),
                                turn_id: Some(event.turn_id.clone()),
                                audit_json: "{}".into(),
                                audit_truncated: false,
                                mutation: ProjectionMutation::UsageDelta(delta),
                                occurred_at: now,
                            },
                        );
                    }
                    Some(ProjectionMutation::Turn(acp_turn_projection(
                        &event.turn_id,
                        if success {
                            TurnStatus::Completed
                        } else {
                            TurnStatus::Failed
                        },
                        message,
                        now,
                        now,
                    )))
                }
                StructuredCliEventKind::PermissionRequest {
                    request_id,
                    tool_use_id,
                    tool_name,
                    input,
                    description,
                    suggestions,
                } => {
                    let command = input
                        .get("command")
                        .and_then(Value::as_str)
                        .map(|text| integrator_runtime::redact_and_bound(text, 64 * 1024).0);
                    let file_tool = matches!(
                        tool_name.as_str(),
                        "Edit" | "Write" | "MultiEdit" | "NotebookEdit"
                    );
                    runtime
                        .permission_requests
                        .lock()
                        .expect("permission lock")
                        .insert(
                            request_id.clone(),
                            PendingStructuredPermission { input, suggestions },
                        );
                    Some(ProjectionMutation::ApprovalRequested {
                        request_id: integrator_core::TransportRequestId::String(request_id),
                        approval_kind: if file_tool {
                            integrator_core::ApprovalKind::FileChange
                        } else {
                            integrator_core::ApprovalKind::CommandExecution
                        },
                        item_id: tool_use_id,
                        approval_id: None,
                        reason: Some(
                            description
                                .filter(|text| !text.is_empty())
                                .unwrap_or_else(|| format!("Use the {tool_name} tool")),
                        ),
                        command,
                        cwd: None,
                    })
                }
                StructuredCliEventKind::Diagnostic { message } => {
                    *runtime.last_diagnostic.lock().expect("diagnostic lock") = Some(message);
                    None
                }
                StructuredCliEventKind::Exited { code, cancelled } => {
                    let diagnostic = runtime
                        .last_diagnostic
                        .lock()
                        .expect("diagnostic lock")
                        .take();
                    *runtime.current_turn.lock().expect("turn lock") = None;
                    // Requests can no longer be answered once the process is
                    // gone; expire them so the UI drops stale popups.
                    runtime
                        .permission_requests
                        .lock()
                        .expect("permission lock")
                        .clear();
                    let _ = store.expire_process_approvals(&runtime.process_id);
                    Some(ProjectionMutation::Turn(acp_turn_projection(
                        &event.turn_id,
                        if cancelled {
                            TurnStatus::Interrupted
                        } else if code == Some(0) {
                            TurnStatus::Completed
                        } else {
                            TurnStatus::Failed
                        },
                        diagnostic,
                        now,
                        now,
                    )))
                }
            };
            if let Some(mutation) = mutation {
                apply_and_emit(
                    &app,
                    &store,
                    &binding,
                    &ReducedProviderEvent {
                        method: "provider/structured/event".into(),
                        thread_id,
                        turn_id: Some(event.turn_id),
                        audit_json: "{}".into(),
                        audit_truncated: false,
                        mutation,
                        occurred_at: now,
                    },
                );
            }
        }
    });
}

/// Maps a structured CLI turn's usage onto an accumulating projection delta.
/// Cache-creation tokens are billed as input, so they fold into
/// `input_tokens`; when the provider omits a grand total (Claude does) it is
/// derived from the parts so the summary's "vendor reported" check still
/// fires. Returns `None` when the turn carried no usage at all (e.g. a
/// resume handshake) so an empty delta never overwrites provenance.
fn structured_usage_delta(usage: &StructuredUsage) -> Option<integrator_core::UsageProjection> {
    let input = usage
        .input_tokens
        .unwrap_or(0)
        .saturating_add(usage.cache_creation_input_tokens.unwrap_or(0));
    let cached = usage.cached_input_tokens.unwrap_or(0);
    let output = usage.output_tokens.unwrap_or(0);
    let reasoning = usage.reasoning_output_tokens.unwrap_or(0);
    let total = usage.total_tokens.unwrap_or_else(|| {
        input
            .saturating_add(cached)
            .saturating_add(output)
            .saturating_add(reasoning)
    });
    if total == 0 && usage.cost_micro_usd.is_none() {
        return None;
    }
    Some(integrator_core::UsageProjection {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: total,
        model_context_window: None,
        vendor_cost_micro_usd: usage.cost_micro_usd,
    })
}

#[allow(clippy::too_many_arguments)]
fn structured_item(
    thread_id: &str,
    turn_id: &str,
    item_id: &str,
    kind: integrator_core::ItemKind,
    title: Option<String>,
    body: Option<String>,
    output: Option<String>,
    status: integrator_core::ItemStatus,
    updated_at: DateTime<Utc>,
) -> integrator_core::ItemProjection {
    integrator_core::ItemProjection {
        id: format!("structured:{thread_id}:{turn_id}:{item_id}"),
        provider_item_id: item_id.to_owned(),
        kind,
        status,
        title: title.map(|value| integrator_runtime::redact_and_bound(&value, 64 * 1024).0),
        body: body.map(|value| integrator_runtime::redact_and_bound(&value, 2 * 1024 * 1024).0),
        command: None,
        cwd: None,
        output: output.map(|value| integrator_runtime::redact_and_bound(&value, 2 * 1024 * 1024).0),
        exit_code: None,
        file_changes: None,
        mcp_server: None,
        mcp_tool: None,
        tool_input: None,
        truncated: false,
        updated_at,
    }
}

/// Forwards ACP agent events through the ACP reducer into SQLite and the
/// renderer, mirroring the Codex pump.
fn spawn_acp_pump(app: AppHandle<tauri::Wry>, store: Arc<LocalStore>, runtime: AcpRuntime) {
    let mut receiver = runtime.client.subscribe();
    tauri::async_runtime::spawn(async move {
        // Assistant text segmentation: whenever a tool call lands after text
        // has streamed, later chunks open a new transcript item so the reply
        // interleaves with tool activity in wire order.
        let mut agent_segment: u32 = 0;
        let mut segment_has_text = false;
        let mut segment_turn: Option<String> = None;
        loop {
            let event = match receiver.recv().await {
                Ok(event) => event,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    acp_connection_event(
                        &app,
                        &store,
                        &runtime,
                        "client/receiverLagged",
                        ConnectionState::Gap,
                        Some("event stream lagged; recovery required"),
                    );
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            let binding = runtime.binding.lock().expect("binding lock").clone();
            let turn_id = runtime.current_turn.lock().expect("turn lock").clone();
            match event {
                adapter_acp::AcpEvent::Notification { method, params } => {
                    if method != "session/update" {
                        continue;
                    }
                    let (Some(binding), Some(turn_id)) = (binding.as_ref(), turn_id.as_deref())
                    else {
                        continue;
                    };
                    let Some(session_id) = binding.thread_id.as_deref() else {
                        continue;
                    };
                    if params.get("sessionId").and_then(Value::as_str) != Some(session_id) {
                        continue;
                    }
                    let Some(update) = params.get("update") else {
                        continue;
                    };
                    if segment_turn.as_deref() != Some(turn_id) {
                        segment_turn = Some(turn_id.to_owned());
                        agent_segment = 0;
                        segment_has_text = false;
                    }
                    match update.get("sessionUpdate").and_then(Value::as_str) {
                        Some("agent_message_chunk") => segment_has_text = true,
                        Some("tool_call") if segment_has_text => {
                            agent_segment += 1;
                            segment_has_text = false;
                        }
                        _ => {}
                    }
                    match reduce_acp_update(session_id, turn_id, agent_segment, update, Utc::now())
                    {
                        Ok(Some(reduced)) => apply_and_emit(&app, &store, binding, &reduced),
                        Ok(None) | Err(_) => {}
                    }
                }
                adapter_acp::AcpEvent::ServerRequest { id, method, params } => {
                    if method != "session/request_permission" {
                        // Unsupported client capability; refuse politely.
                        let _ = runtime
                            .client
                            .respond_to_server_request(
                                &id,
                                serde_json::json!({ "error": "unsupported" }),
                            )
                            .await;
                        continue;
                    }
                    let (Some(binding), Some(turn_id)) = (binding.as_ref(), turn_id.as_deref())
                    else {
                        continue;
                    };
                    let Some(session_id) = binding.thread_id.as_deref() else {
                        continue;
                    };
                    let request_id = acp_transport_id(&id);
                    let options = params
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|options| {
                            options
                                .iter()
                                .filter_map(|option| {
                                    Some(AcpPermissionOption {
                                        option_id: option
                                            .get("optionId")
                                            .and_then(Value::as_str)?
                                            .to_owned(),
                                        kind: option
                                            .get("kind")
                                            .and_then(Value::as_str)
                                            .unwrap_or_default()
                                            .to_owned(),
                                    })
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    runtime
                        .permission_options
                        .lock()
                        .expect("permission lock")
                        .insert(transport_key(&request_id), options);
                    let reduced = reduce_acp_permission_request(
                        session_id,
                        turn_id,
                        request_id,
                        &params,
                        Utc::now(),
                    );
                    apply_and_emit(&app, &store, binding, &reduced);
                }
                adapter_acp::AcpEvent::ProtocolViolation { code } => {
                    acp_connection_event(
                        &app,
                        &store,
                        &runtime,
                        "client/protocolViolation",
                        ConnectionState::Gap,
                        Some(&code),
                    );
                }
                adapter_acp::AcpEvent::StderrActivity => {}
                adapter_acp::AcpEvent::Exited => {
                    let _ = store.expire_process_approvals(&runtime.process_id);
                    acp_connection_event(
                        &app,
                        &store,
                        &runtime,
                        "provider/exited",
                        ConnectionState::Disconnected,
                        Some(&format!("{} agent exited", runtime.provider.as_str())),
                    );
                    break;
                }
            }
        }
    });
}

fn acp_connection_event(
    app: &AppHandle<tauri::Wry>,
    store: &LocalStore,
    runtime: &AcpRuntime,
    method: &str,
    connection: ConnectionState,
    reason: Option<&str>,
) {
    let Some(binding) = runtime.binding.lock().expect("binding lock").clone() else {
        return;
    };
    let Some(session_id) = binding.thread_id.clone() else {
        return;
    };
    let reduced = reduce_connection_event(method, &session_id, connection, reason, Utc::now());
    apply_and_emit(app, store, &binding, &reduced);
}

pub(crate) fn apply_and_emit(
    app: &AppHandle<tauri::Wry>,
    store: &LocalStore,
    binding: &RuntimeBinding,
    reduced: &ReducedProviderEvent,
) {
    if let Ok(event) = store.apply_reduced_event(binding, reduced) {
        let _ = app.emit("runtime://projection", &event);
    }
}

fn acp_transport_id(id: &adapter_acp::AcpRequestId) -> TransportRequestId {
    match id.to_protocol_value() {
        Value::Number(number) => TransportRequestId::Number(number),
        Value::String(text) => TransportRequestId::String(text),
        _ => unreachable!("ACP request ids are numbers or strings"),
    }
}

fn acp_request_from_transport(
    id: &TransportRequestId,
) -> Result<adapter_acp::AcpRequestId, CommandError> {
    let value = match id {
        TransportRequestId::Number(number) => Value::Number(number.clone()),
        TransportRequestId::String(text) => Value::String(text.clone()),
    };
    adapter_acp::AcpRequestId::from_protocol_value(&value).map_err(CommandError::from)
}

fn transport_key(id: &TransportRequestId) -> String {
    match id {
        TransportRequestId::Number(number) => format!("n:{number}"),
        TransportRequestId::String(text) => format!("s:{text}"),
    }
}

/// Build the `can_use_tool` control response for a UI approval decision on
/// the structured (stream-json) route. Allow echoes the original tool input;
/// allow-for-session additionally echoes the CLI's own permission
/// suggestions so the vendor persists the rule itself.
fn structured_permission_response(
    decision: ApprovalDecision,
    pending: Option<PendingStructuredPermission>,
) -> Value {
    match decision {
        ApprovalDecision::Accept | ApprovalDecision::AcceptForSession => {
            let mut response = serde_json::json!({ "behavior": "allow" });
            if let Some(pending) = pending {
                if !pending.input.is_null() {
                    response["updatedInput"] = pending.input;
                }
                if matches!(decision, ApprovalDecision::AcceptForSession)
                    && pending
                        .suggestions
                        .as_array()
                        .is_some_and(|s| !s.is_empty())
                {
                    response["updatedPermissions"] = pending.suggestions;
                }
            }
            response
        }
        ApprovalDecision::Decline | ApprovalDecision::Cancel => serde_json::json!({
            "behavior": "deny",
            "message": "The user declined this request.",
        }),
    }
}

/// Map the UI approval decision onto the option set the ACP agent advertised
/// for this request. Options live only as long as the agent process.
fn acp_permission_outcome(
    runtime: &AcpRuntime,
    request_id: &TransportRequestId,
    decision: ApprovalDecision,
) -> Value {
    if matches!(decision, ApprovalDecision::Cancel) {
        return serde_json::json!({ "outcome": { "outcome": "cancelled" } });
    }
    let options = runtime
        .permission_options
        .lock()
        .expect("permission lock")
        .remove(&transport_key(request_id))
        .unwrap_or_default();
    let preferred: &[&str] = match decision {
        ApprovalDecision::Accept => &["allow_once", "allow_always"],
        ApprovalDecision::AcceptForSession => &["allow_always", "allow_once"],
        ApprovalDecision::Decline => &["reject_once", "reject_always"],
        ApprovalDecision::Cancel => &[],
    };
    let selected = preferred
        .iter()
        .find_map(|kind| options.iter().find(|option| option.kind == *kind))
        .or_else(|| {
            let prefix = if matches!(decision, ApprovalDecision::Decline) {
                "reject"
            } else {
                "allow"
            };
            options
                .iter()
                .find(|option| option.kind.starts_with(prefix))
        });
    match selected {
        Some(option) => serde_json::json!({
            "outcome": { "outcome": "selected", "optionId": option.option_id }
        }),
        None => serde_json::json!({ "outcome": { "outcome": "cancelled" } }),
    }
}

async fn acp_runtime(state: &State<'_, AppState>) -> CommandResult<AcpRuntime> {
    state.acp.lock().await.clone().ok_or_else(|| CommandError {
        code: "provider-disconnected",
        message: "Cursor is not connected".into(),
    })
}

async fn codex_runtime(state: &State<'_, AppState>) -> CommandResult<CodexRuntime> {
    state
        .codex
        .lock()
        .await
        .clone()
        .ok_or_else(|| CommandError {
            code: "provider-disconnected",
            message: "Codex is not connected".into(),
        })
}

async fn codex_client(state: &State<'_, AppState>) -> CommandResult<adapter_codex::CodexClient> {
    Ok(codex_runtime(state).await?.client)
}

fn reconcile_turn_response(
    app: &AppHandle<tauri::Wry>,
    store: &LocalStore,
    runtime: &CodexRuntime,
    thread_id: &str,
    response: &Value,
) {
    let Some(turn) = response.get("turn") else {
        return;
    };
    let binding = runtime.binding.lock().expect("binding lock").clone();
    pump_provider_event(
        app,
        store,
        binding.as_ref(),
        "turn/started".into(),
        serde_json::json!({ "threadId": thread_id, "turn": turn }),
        None,
    );
}

fn reconcile_thread_response(
    app: &AppHandle<tauri::Wry>,
    store: &LocalStore,
    runtime: &CodexRuntime,
    response: &Value,
) {
    let Some(thread) = response.get("thread") else {
        return;
    };
    let Some(thread_id) = thread.get("id").and_then(Value::as_str) else {
        return;
    };
    let binding = runtime.binding.lock().expect("binding lock").clone();
    for turn in thread
        .get("turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let turn_id = turn.get("id").and_then(Value::as_str).unwrap_or("unknown");
        let method = if turn.get("status").and_then(Value::as_str) == Some("inProgress") {
            "turn/started"
        } else {
            "turn/completed"
        };
        pump_provider_event(
            app,
            store,
            binding.as_ref(),
            method.into(),
            serde_json::json!({ "threadId": thread_id, "turn": turn }),
            None,
        );
        for item in turn
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            pump_provider_event(
                app,
                store,
                binding.as_ref(),
                "item/completed".into(),
                serde_json::json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": item
                }),
                None,
            );
        }
    }
}

fn extract_thread_id(value: &Value) -> Option<String> {
    value
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .or_else(|| value.get("threadId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

async fn authorized_git(
    state: &State<'_, AppState>,
    repository: PathBuf,
) -> CommandResult<(GitService, RepositoryIdentity)> {
    let git = state.git.clone().ok_or_else(git_unavailable)?;
    let authorization_git = git.clone();
    let store = Arc::clone(&state.store);
    let identity = tauri::async_runtime::spawn_blocking(move || {
        let projects = store.list_trusted_projects()?;
        authorize_repository(&authorization_git, &projects, &repository)
    })
    .await
    .map_err(|_| worker_error())?
    .map_err(CommandError::from)?;
    Ok((git, identity))
}

fn list_project_files(root: &Path) -> integrator_core::Result<Vec<ProjectFileEntry>> {
    let mut files = Vec::new();
    collect_project_files(root, root, &mut files)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn collect_project_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<ProjectFileEntry>,
) -> integrator_core::Result<()> {
    if files.len() >= MAX_PROJECT_FILE_ENTRIES {
        return Ok(());
    }
    let entries = fs::read_dir(directory).map_err(io_error)?;
    for entry in entries {
        if files.len() >= MAX_PROJECT_FILE_ENTRIES {
            return Ok(());
        }
        let entry = entry.map_err(io_error)?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let file_type = entry.file_type().map_err(io_error)?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            if should_skip_project_directory(&name) {
                continue;
            }
            collect_project_files(root, &path, files)?;
        } else if file_type.is_file() {
            let relative = path.strip_prefix(root).map_err(|_| {
                IntegratorError::Unauthorized("file escaped trusted repository".into())
            })?;
            if is_sensitive_project_file(relative) {
                continue;
            }
            files.push(ProjectFileEntry {
                path: normalized_relative_path(relative),
                size: entry.metadata().map_err(io_error)?.len(),
            });
        }
    }
    Ok(())
}

fn read_project_file(
    root: &Path,
    requested_path: &str,
) -> integrator_core::Result<ProjectFileContent> {
    let relative = validate_project_relative_path(requested_path)?;
    if is_sensitive_project_file(&relative) {
        return Err(IntegratorError::Unauthorized(
            "sensitive project files cannot be previewed".into(),
        ));
    }
    let candidate = root.join(&relative);
    // Keep the same Windows path normalization used by Git authorization. The
    // standard canonicalizer may add a `\\?\` prefix, which would make a valid
    // child path fail the trusted-root containment check below.
    let canonical = dunce::canonicalize(&candidate).map_err(io_error)?;
    if !canonical.starts_with(root) {
        return Err(IntegratorError::Unauthorized(
            "file is outside the trusted repository".into(),
        ));
    }
    let metadata = fs::metadata(&canonical).map_err(io_error)?;
    if !metadata.is_file() {
        return Err(IntegratorError::InvalidInput(
            "requested path is not a file".into(),
        ));
    }
    if metadata.len() > MAX_PROJECT_FILE_BYTES {
        return Err(IntegratorError::Unavailable(format!(
            "file is larger than the {} KB safe preview limit",
            MAX_PROJECT_FILE_BYTES / 1_000
        )));
    }
    let bytes = fs::read(&canonical).map_err(io_error)?;
    let is_binary = bytes.contains(&0);
    Ok(ProjectFileContent {
        path: normalized_relative_path(&relative),
        content: if is_binary {
            String::new()
        } else {
            String::from_utf8_lossy(&bytes).into_owned()
        },
        is_binary,
    })
}

fn validate_project_relative_path(value: &str) -> integrator_core::Result<PathBuf> {
    let path = Path::new(value);
    if value.trim().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(IntegratorError::InvalidInput(
            "file path must be a relative project path".into(),
        ));
    }
    Ok(path.to_path_buf())
}

fn normalized_relative_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn should_skip_project_directory(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | "coverage"
            | ".venv"
            | "vendor"
    )
}

fn is_sensitive_project_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return true;
    };
    let normalized = name.to_ascii_lowercase();
    let protected_env = normalized == ".env"
        || (normalized.starts_with(".env.")
            && !normalized.ends_with(".example")
            && !normalized.ends_with(".sample")
            && !normalized.ends_with(".template"));
    protected_env
        || normalized.ends_with(".pem")
        || normalized.ends_with(".p12")
        || normalized.ends_with(".pfx")
        || normalized.ends_with(".key")
        || matches!(
            normalized.as_str(),
            "id_rsa" | "id_ed25519" | "credentials.json" | "service-account.json"
        )
}

fn io_error(error: std::io::Error) -> IntegratorError {
    IntegratorError::Io(error)
}

fn git_unavailable() -> CommandError {
    CommandError {
        code: "git-unavailable",
        message: "Git is not installed".into(),
    }
}
fn worker_error() -> CommandError {
    CommandError {
        code: "worker-failed",
        message: "local worker stopped unexpectedly".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_id_is_extracted_from_supported_shapes() {
        assert_eq!(
            extract_thread_id(&serde_json::json!({ "thread": { "id": "abc" } })),
            Some("abc".into())
        );
        assert_eq!(
            extract_thread_id(&serde_json::json!({ "threadId": "def" })),
            Some("def".into())
        );
    }

    #[test]
    fn acp_launch_is_provider_aware_and_rejects_non_acp_routes() {
        assert_eq!(
            acp_launch_arguments(&ProviderKind::Cursor).expect("Cursor ACP route"),
            vec!["acp"]
        );
        assert!(acp_launch_arguments(&ProviderKind::Antigravity).is_err());
        assert!(acp_launch_arguments(&ProviderKind::Claude).is_err());
    }

    #[test]
    fn structured_routes_are_limited_to_preview_cli_providers() {
        assert_eq!(
            structured_provider(&ProviderKind::Claude).expect("Claude structured route"),
            StructuredCliProvider::Claude
        );
        assert_eq!(
            structured_provider(&ProviderKind::Antigravity).expect("Antigravity structured route"),
            StructuredCliProvider::Antigravity
        );
        assert!(structured_provider(&ProviderKind::Cursor).is_err());
    }

    #[test]
    fn cd_builtin_is_recognized_and_unquoted() {
        assert_eq!(parse_cd_command("cd"), Some(""));
        assert_eq!(parse_cd_command("cd src"), Some("src"));
        assert_eq!(parse_cd_command("cd \"my dir\""), Some("my dir"));
        assert_eq!(parse_cd_command("cd 'my dir'"), Some("my dir"));
        assert_eq!(parse_cd_command("cdx"), None);
        assert_eq!(parse_cd_command("echo cd"), None);
    }

    #[test]
    fn terminal_cd_never_escapes_the_trusted_root() {
        let root = std::env::temp_dir().join(format!("terminal-cd-{}", uuid::Uuid::new_v4()));
        let inside = root.join("inside");
        fs::create_dir_all(&inside).expect("create test directories");
        let canonical_root = dunce::canonicalize(&root).expect("canonicalize root");

        let resolved = resolve_terminal_cd(&canonical_root, &canonical_root, "inside")
            .expect("descend into a child directory");
        assert!(resolved.starts_with(&canonical_root));
        assert_eq!(
            resolve_terminal_cd(&canonical_root, &resolved, "").expect("bare cd returns to root"),
            canonical_root
        );
        let escape = resolve_terminal_cd(&canonical_root, &resolved, "../..");
        assert!(escape.is_err(), "parent traversal past the root must fail");

        fs::remove_dir_all(&root).expect("clean up test directories");
    }

    #[test]
    fn reads_a_nested_project_file_with_the_trusted_root_normalization() {
        let root = std::env::temp_dir().join(format!("project-files-{}", uuid::Uuid::new_v4()));
        let nested = root.join("src").join("runtime");
        fs::create_dir_all(&nested).expect("create nested project directory");
        fs::write(nested.join("router.ts"), "export const route = true;\n")
            .expect("write project file");

        let content =
            read_project_file(&root, "src/runtime/router.ts").expect("read nested project file");
        assert_eq!(content.path, "src/runtime/router.ts");
        assert_eq!(content.content, "export const route = true;\n");
        assert!(!content.is_binary);

        fs::remove_dir_all(&root).expect("clean up project directory");
    }
}
