use std::{path::PathBuf, sync::Arc};

use integrator_core::{IntegratorError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
    io::AsyncWriteExt,
    sync::{Mutex, broadcast, oneshot},
};

mod launch;
mod parse;
mod process;
#[cfg(test)]
use launch::{antigravity_prompt_with_images, provider_args};
#[cfg(test)]
use parse::{ParsedEvent, parse_provider_line};
use process::{ChildTurnContext, run_child, spawn_structured_child};

// Sized for fast token-delta bursts: the consumer persists each event, so a
// small ring converts brief persistence stalls into dropped stream chunks.
const EVENT_CAPACITY: usize = 2048;
const DIAGNOSTIC_LIMIT: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StructuredCliProvider {
    Claude,
    /// Google Antigravity CLI (`agy`), the successor to the retired Gemini
    /// CLI. Print mode emits one final JSON object per turn (no streaming).
    Antigravity,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StructuredPermissionMode {
    Prompt,
    ReadOnly,
    /// General Chat: no coding tools or provider customizations. Provider
    /// adapters may still project the one explicitly configured Chat MCP.
    Chat,
    AcceptEdits,
    /// Skip provider approval prompts entirely. Only reachable from the
    /// explicit "Full access" profile the user picked in the composer.
    BypassPermissions,
}

#[derive(Clone, Debug)]
pub struct StructuredCliLaunchOptions {
    pub provider: StructuredCliProvider,
    pub executable: PathBuf,
    pub working_directory: PathBuf,
    pub model: Option<String>,
    /// Reasoning effort. Only Claude exposes a CLI flag for this (`--effort`);
    /// other providers ignore it.
    pub effort: Option<String>,
    /// Durable AI Integrator policy carried in the provider's native system
    /// instruction layer. Claude receives this through
    /// `--append-system-prompt`; Antigravity loads it from the private control
    /// overlay instead.
    pub system_instructions: Option<String>,
    pub resume_session_id: Option<String>,
    pub permission_mode: StructuredPermissionMode,
    /// MCP config file granting this session the delegation-broker tool
    /// surface. Claude-only in v1: the flag pair is not portable, so other
    /// providers ignore it.
    pub mcp_config_path: Option<PathBuf>,
    /// Integrator-owned Antigravity customization root. The directory may
    /// contain `.agents/hooks.json` and `.agents/mcp_config.json`, but is
    /// never written into the user's repository. Other providers ignore it.
    pub control_overlay: Option<PathBuf>,
    /// Integrator-owned plugin bundles projected into this turn, one
    /// `--plugin-dir` each. Claude-only: the flag is not portable, so other
    /// providers ignore it. Overlays live in app-data, never the repository.
    pub plugin_dirs: Vec<PathBuf>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuredUsage {
    pub input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    /// Tokens spent writing the prompt cache (Claude's
    /// `cache_creation_input_tokens`). Billed as input; kept separate so the
    /// projection can fold them into input without double-counting cache reads.
    pub cache_creation_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    /// Reasoning tokens (agy's `thinking_tokens`). Claude does not report them.
    pub reasoning_output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    /// Vendor-computed API-equivalent cost in micro-USD (Claude's
    /// `total_cost_usd`). A client-side estimate, not a bill; integer so the
    /// projection types stay `Eq`.
    pub cost_micro_usd: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StructuredCliEventKind {
    Init {
        model: Option<String>,
    },
    Text {
        text: String,
        delta: bool,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        id: String,
        is_error: bool,
        content: String,
    },
    /// An official provider hook blocked the action before execution.
    ToolDenied {
        id: String,
        content: String,
    },
    Result {
        success: bool,
        message: Option<String>,
        usage: StructuredUsage,
    },
    /// The CLI is asking whether the agent may use a tool (Claude's
    /// stream-json `control_request`/`can_use_tool`). The turn stays blocked
    /// until `respond_permission` writes the matching `control_response`.
    PermissionRequest {
        request_id: String,
        tool_use_id: String,
        tool_name: String,
        input: Value,
        description: Option<String>,
        /// `permission_suggestions` passed through verbatim so an
        /// "always allow" decision can echo them back to the CLI.
        suggestions: Value,
    },
    Diagnostic {
        message: String,
    },
    /// The CLI reported a permission-mode change (Claude's stream-json
    /// `system`/`status` message, e.g. after an approved `ExitPlanMode`).
    PermissionModeChanged {
        mode: String,
    },
    Exited {
        code: Option<i32>,
        cancelled: bool,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StructuredCliEvent {
    pub turn_id: String,
    pub session_id: Option<String>,
    pub event: StructuredCliEventKind,
}

#[derive(Clone)]
pub struct StructuredCliClient {
    events: broadcast::Sender<StructuredCliEvent>,
    active: Arc<Mutex<Option<ActiveTurn>>>,
}

struct ActiveTurn {
    turn_id: String,
    cancel: oneshot::Sender<()>,
    /// Kept open for Claude so permission `control_response` lines can be
    /// written mid-turn. `None` once the turn result closed the pipe (or for
    /// providers without a control channel).
    stdin: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
}

impl Default for StructuredCliClient {
    fn default() -> Self {
        Self::new()
    }
}

impl StructuredCliClient {
    #[must_use]
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        Self {
            events,
            active: Arc::new(Mutex::new(None)),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<StructuredCliEvent> {
        self.events.subscribe()
    }

    /// Publishes a typed event observed through a provider-owned lifecycle
    /// hook. The desktop host uses this for Agy because its print JSON is
    /// final-only; arbitrary hook payloads never cross this boundary.
    pub fn emit_host_event(
        &self,
        turn_id: &str,
        session_id: Option<String>,
        event: StructuredCliEventKind,
    ) {
        let _ = self.events.send(StructuredCliEvent {
            turn_id: turn_id.to_owned(),
            session_id,
            event,
        });
    }

    /// Starts one structured CLI turn. Prompt content is written over stdin and
    /// is never included in the child process command line.
    pub async fn start_turn(
        &self,
        options: StructuredCliLaunchOptions,
        prompt: String,
    ) -> Result<String> {
        self.start_turn_with_images(options, prompt, Vec::new())
            .await
    }

    /// Same as [`Self::start_turn`], reattaching local images for handoff.
    /// Claude receives multimodal content blocks; Antigravity gets workspace-
    /// scoped `@{path}` references that its prompt loader resolves as media.
    pub async fn start_turn_with_images(
        &self,
        options: StructuredCliLaunchOptions,
        prompt: String,
        image_paths: Vec<PathBuf>,
    ) -> Result<String> {
        let mut active = self.active.lock().await;
        if active.is_some() {
            return Err(IntegratorError::Unavailable(
                "a structured CLI turn is already running".into(),
            ));
        }
        let turn_id = uuid::Uuid::new_v4().to_string();
        let (cancel, cancel_rx) = oneshot::channel();
        let stdin_slot: Arc<Mutex<Option<tokio::process::ChildStdin>>> = Arc::new(Mutex::new(None));
        *active = Some(ActiveTurn {
            turn_id: turn_id.clone(),
            cancel,
            stdin: Arc::clone(&stdin_slot),
        });

        let child = match spawn_structured_child(&options) {
            Ok(child) => child,
            Err(error) => {
                *active = None;
                return Err(error);
            }
        };
        let events = self.events.clone();
        let active_turn = Arc::clone(&self.active);
        let task_turn_id = turn_id.clone();
        tokio::spawn(async move {
            let context =
                ChildTurnContext::new(task_turn_id.clone(), cancel_rx, events, stdin_slot);
            run_child(child, options.provider, prompt, image_paths, context).await;
            let mut active = active_turn.lock().await;
            if active
                .as_ref()
                .is_some_and(|turn| turn.turn_id == task_turn_id)
            {
                *active = None;
            }
        });
        Ok(turn_id)
    }

    /// Answers a pending `can_use_tool` permission request by writing the
    /// matching `control_response` line to the provider's stdin. `response`
    /// is the protocol payload, e.g. `{"behavior":"allow","updatedInput":{..}}`
    /// or `{"behavior":"deny","message":".."}`.
    pub async fn respond_permission(&self, request_id: &str, response: Value) -> Result<()> {
        let stdin = {
            let active = self.active.lock().await;
            let Some(turn) = active.as_ref() else {
                return Err(IntegratorError::Unavailable(
                    "no structured CLI turn is running".into(),
                ));
            };
            Arc::clone(&turn.stdin)
        };
        let mut guard = stdin.lock().await;
        let Some(writer) = guard.as_mut() else {
            return Err(IntegratorError::Unavailable(
                "the structured CLI control channel is closed".into(),
            ));
        };
        let line = serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": response,
            },
        });
        let mut payload = line.to_string();
        payload.push('\n');
        writer
            .write_all(payload.as_bytes())
            .await
            .map_err(IntegratorError::from)?;
        writer.flush().await.map_err(IntegratorError::from)
    }

    pub async fn cancel(&self, turn_id: &str) -> Result<bool> {
        let mut active = self.active.lock().await;
        let Some(turn) = active.take() else {
            return Ok(false);
        };
        if turn.turn_id != turn_id {
            *active = Some(turn);
            return Err(IntegratorError::Unavailable(
                "the requested structured CLI turn is not active".into(),
            ));
        }
        let _ = turn.cancel.send(());
        Ok(true)
    }
}

#[cfg(test)]
mod tests;
