//! `integrator.exe --broker-mcp`: a thin stdio MCP server that provider CLIs
//! spawn from injected MCP config. It exposes task-scoped Integrator tools
//! and forwards every `tools/call` to the app's loopback host as one
//! line-delimited JSON-RPC request.
//!
//! Deliberately synchronous and dependency-light: one request in flight at a
//! time, no Tauri, no tokio. If the app (and thus the broker) goes away the
//! bridge reports tool errors rather than crashing the host CLI session.

use std::{
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    time::Duration,
};

use serde_json::{Value, json};

const PROTOCOL_VERSION: &str = "2024-11-05";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

struct BrokerLink {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
    next_id: u64,
}

impl BrokerLink {
    fn connect() -> Result<Self, String> {
        let addr = std::env::var("INTEGRATOR_BROKER_ADDR")
            .map_err(|_| "INTEGRATOR_BROKER_ADDR is not set".to_owned())?;
        let token = std::env::var("INTEGRATOR_BROKER_TOKEN")
            .map_err(|_| "INTEGRATOR_BROKER_TOKEN is not set".to_owned())?;
        let role = broker_role();
        let scope = std::env::var("INTEGRATOR_BROKER_SCOPE").unwrap_or_default();
        let mode = std::env::var("INTEGRATOR_BROKER_MODE").unwrap_or_else(|_| "balanced".into());
        let addr = addr
            .parse::<std::net::SocketAddr>()
            .map_err(|_| "invalid broker address".to_owned())?;
        let stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)
            .map_err(|error| format!("broker unreachable: {error}"))?;
        stream.set_read_timeout(Some(CALL_TIMEOUT)).ok();
        stream.set_write_timeout(Some(CALL_TIMEOUT)).ok();
        let reader = BufReader::new(
            stream
                .try_clone()
                .map_err(|error| format!("broker stream: {error}"))?,
        );
        let mut link = Self {
            reader,
            writer: stream,
            next_id: 1,
        };
        let hello = link.request(
            "hello",
            json!({ "token": token, "role": role, "scope": scope, "mode": mode }),
        )?;
        if hello.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err("broker rejected the session".into());
        }
        Ok(link)
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let mut payload = json!({ "id": id, "method": method, "params": params }).to_string();
        payload.push('\n');
        self.writer
            .write_all(payload.as_bytes())
            .map_err(|error| format!("broker write failed: {error}"))?;
        let mut line = String::new();
        loop {
            line.clear();
            let read = self
                .reader
                .read_line(&mut line)
                .map_err(|error| format!("broker read failed: {error}"))?;
            if read == 0 {
                return Err("broker connection closed".into());
            }
            let Ok(response) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if response.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = response.get("error") {
                return Err(error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("broker error")
                    .to_owned());
            }
            return Ok(response.get("result").cloned().unwrap_or(Value::Null));
        }
    }
}

fn broker_role() -> String {
    std::env::var("INTEGRATOR_BROKER_ROLE").unwrap_or_else(|_| "orchestrator".into())
}

fn broker_mode() -> String {
    std::env::var("INTEGRATOR_BROKER_MODE").unwrap_or_else(|_| "off".into())
}

fn broker_instructions() -> Option<String> {
    std::env::var("INTEGRATOR_BROKER_INSTRUCTIONS")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty() && value.len() <= 2_048)
}

fn initialize_result(protocol_version: &str) -> Value {
    json!({
        "protocolVersion": protocol_version,
        "capabilities": { "tools": {} },
        "serverInfo": {
            "name": "integrator-local-tools",
            "version": env!("CARGO_PKG_VERSION"),
        },
    })
}

fn text_schema(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required })
}

fn tool_annotations(read_only: bool, destructive: bool) -> Value {
    json!({
        "readOnlyHint": read_only,
        "destructiveHint": destructive,
        "openWorldHint": false,
    })
}

fn skill_data_tool(harness_instructions: Option<&str>) -> Value {
    let mut description = "Fetch read-only data from one allowlisted official provider using a \
        credential saved in AI Integrator Settings. The credential stays inside the running \
        native app. Provider values: fred, bls, census, eia, alpha-vantage. FRED, Census, and EIA \
        require an official path; BLS takes a JSON body; Alpha Vantage uses its fixed /query path."
        .to_owned();
    if let Some(instructions) = harness_instructions {
        description.push_str("\n\n");
        description.push_str(instructions);
    }
    json!({
        "name": "skill_data_request",
        "description": description,
        "annotations": {
            "readOnlyHint": true,
            "destructiveHint": false,
            "openWorldHint": true,
        },
        "inputSchema": text_schema(json!({
            "provider": {
                "type": "string",
                "enum": ["fred", "bls", "census", "eia", "alpha-vantage"]
            },
            "path": {
                "type": "string",
                "description": "Official provider path. Required for FRED, Census, and EIA; omit for BLS and Alpha Vantage."
            },
            "query": {
                "type": "object",
                "description": "Public query parameters. Credential parameter names are reserved and rejected."
            },
            "body": {
                "type": "object",
                "description": "Public JSON body for BLS. registrationkey is reserved and injected by AI Integrator."
            }
        }), &["provider"]),
    })
}

fn tool_definitions(role: &str, mode: &str, harness_instructions: Option<&str>) -> Vec<Value> {
    let data_tool = skill_data_tool(harness_instructions);
    match role {
        "child" => vec![
            data_tool,
            json!({
                "name": "task_complete",
                "description": "Report that your delegated assignment is finished. The summary is your deliverable — include what you did, files touched, and caveats. Always call this exactly once when done.",
                "annotations": tool_annotations(false, false),
                "inputSchema": text_schema(json!({
                    "summary": { "type": "string", "description": "Concise deliverable summary for the orchestrator." }
                }), &["summary"]),
            }),
            json!({
                "name": "orchestrator_ask",
                "description": "Queue a question for the orchestrator that delegated this work. Asynchronous: the answer arrives in a later turn, so keep making progress on whatever does not depend on it.",
                "annotations": tool_annotations(false, false),
                "inputSchema": text_schema(json!({
                    "message": { "type": "string", "description": "Your question, with enough context to answer without seeing your transcript." }
                }), &["message"]),
            }),
            json!({
                "name": "orchestrator_report",
                "description": "Queue a progress note for the orchestrator on long-running work. Fire and forget.",
                "annotations": tool_annotations(false, false),
                "inputSchema": text_schema(json!({
                    "message": { "type": "string", "description": "Short progress update." }
                }), &["message"]),
            }),
        ],
        _ if mode == "off" => vec![data_tool],
        _ => vec![
            data_tool,
            json!({
                "name": "peers_list",
                "description": "List the delegation profiles the user has enabled (other AI coding agents you may delegate subtasks to), with cost tiers and current concurrency headroom.",
                "annotations": tool_annotations(true, false),
                "inputSchema": text_schema(json!({}), &[]),
            }),
            json!({
                "name": "delegate_start",
                "description": "Delegate a self-contained subtask to a subagent on another provider. Fully asynchronous: returns a delegationId immediately while the subagent works in the background — continue your own work and check in later. The brief must stand alone: the subagent sees only recent conversation context plus your brief. Set permission to read-only for research, audits, and repo orientation; use project-write only when the child must modify the workspace.",
                "annotations": tool_annotations(false, false),
                "inputSchema": text_schema(json!({
                    "profileId": { "type": "string", "description": "A profileId from peers_list." },
                    "title": { "type": "string", "description": "Short provisional label for the subtask. The app applies its subagent-number convention and may replace this with an automatically generated chat name." },
                    "brief": { "type": "string", "description": "Complete standalone instructions: goal, constraints, files, and the deliverable you expect back." },
                    "permission": { "type": "string", "enum": ["read-only", "project-write"], "default": "project-write", "description": "Enforced child workspace permission. Use read-only whenever edits are not required." }
                }), &["profileId", "title", "brief"]),
            }),
            json!({
                "name": "delegation_status",
                "description": "Check on your delegated subagents: status, results, and any queued questions or reports from them. Omit delegationId to list all. Answer subagent questions with delegation_message.",
                "annotations": tool_annotations(false, false),
                "inputSchema": text_schema(json!({
                    "delegationId": { "type": "string", "description": "Optional: one delegation to inspect." }
                }), &[]),
            }),
            json!({
                "name": "delegation_message",
                "description": "Send guidance, corrections, or answers to a running subagent. Delivered when the subagent is idle — it never interrupts a turn in progress.",
                "annotations": tool_annotations(false, false),
                "inputSchema": text_schema(json!({
                    "delegationId": { "type": "string" },
                    "message": { "type": "string", "description": "Guidance or an answer to the subagent's question." }
                }), &["delegationId", "message"]),
            }),
            json!({
                "name": "delegation_result",
                "description": "Fetch a delegation's deliverable: the subagent's reported summary plus a digest of its transcript.",
                "annotations": tool_annotations(true, false),
                "inputSchema": text_schema(json!({
                    "delegationId": { "type": "string" }
                }), &["delegationId"]),
            }),
            json!({
                "name": "delegation_stop",
                "description": "Stop a delegated subagent that is no longer needed.",
                "annotations": tool_annotations(false, true),
                "inputSchema": text_schema(json!({
                    "delegationId": { "type": "string" }
                }), &["delegationId"]),
            }),
        ],
    }
}

fn respond(stdout: &mut impl Write, id: Value, result: Value) {
    let mut payload = json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string();
    payload.push('\n');
    let _ = stdout.write_all(payload.as_bytes());
    let _ = stdout.flush();
}

fn respond_error(stdout: &mut impl Write, id: Value, code: i64, message: &str) {
    let mut payload =
        json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
            .to_string();
    payload.push('\n');
    let _ = stdout.write_all(payload.as_bytes());
    let _ = stdout.flush();
}

/// Entry point for `--broker-mcp` mode. Returns the process exit code.
pub fn run() -> i32 {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    let role = broker_role();
    let mode = broker_mode();
    let mut link: Option<BrokerLink> = None;
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        // Some shells prepend a BOM to the first piped line; strip it so the
        // initialize request is never silently dropped.
        let line = line.trim_start_matches('\u{feff}').trim();
        if line.is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let id = message.get("id").cloned();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let Some(id) = id else {
            // Notification (e.g. notifications/initialized): nothing to do.
            continue;
        };
        match method.as_str() {
            "initialize" => {
                let requested = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or(PROTOCOL_VERSION);
                respond(&mut stdout, id, initialize_result(requested));
            }
            "ping" => respond(&mut stdout, id, json!({})),
            "tools/list" => respond(
                &mut stdout,
                id,
                json!({
                    "tools": tool_definitions(
                        &role,
                        &mode,
                        broker_instructions().as_deref(),
                    )
                }),
            ),
            "tools/call" => {
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
                if link.is_none() {
                    link = match BrokerLink::connect() {
                        Ok(connected) => Some(connected),
                        Err(error) => {
                            respond(
                                &mut stdout,
                                id,
                                tool_error(&format!("Integrator local tools unavailable: {error}")),
                            );
                            continue;
                        }
                    };
                }
                let outcome = link
                    .as_mut()
                    .expect("link connected above")
                    .request(&name, arguments);
                match outcome {
                    Ok(result) => respond(
                        &mut stdout,
                        id,
                        json!({
                            "content": [{
                                "type": "text",
                                "text": serde_json::to_string_pretty(&result)
                                    .unwrap_or_else(|_| result.to_string()),
                            }],
                            "isError": false,
                        }),
                    ),
                    Err(error) => {
                        // A failed request can leave the link desynchronized;
                        // reconnect lazily on the next call.
                        link = None;
                        respond(&mut stdout, id, tool_error(&error));
                    }
                }
            }
            _ => respond_error(&mut stdout, id, -32601, "method not found"),
        }
    }
    0
}

fn tool_error(message: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": message }],
        "isError": true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_lists_are_role_scoped() {
        let orchestrator: Vec<String> = tool_definitions("orchestrator", "balanced", None)
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_owned))
            .collect();
        assert!(orchestrator.contains(&"delegate_start".to_owned()));
        assert!(orchestrator.contains(&"skill_data_request".to_owned()));
        assert!(!orchestrator.contains(&"task_complete".to_owned()));

        let child: Vec<String> = tool_definitions("child", "off", None)
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_owned))
            .collect();
        assert!(child.contains(&"task_complete".to_owned()));
        assert!(child.contains(&"skill_data_request".to_owned()));
        assert!(!child.contains(&"delegate_start".to_owned()));

        let delegation_off: Vec<String> = tool_definitions("orchestrator", "off", None)
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_owned))
            .collect();
        assert_eq!(delegation_off, vec!["skill_data_request"]);
    }

    #[test]
    fn cursor_receives_harness_policy_in_the_always_present_tool_schema() {
        let tools = tool_definitions("orchestrator", "off", Some("durable harness policy"));
        let description = tools[0]["description"].as_str().expect("tool description");
        assert!(description.contains("Fetch read-only data"));
        assert!(description.contains("durable harness policy"));
    }

    #[test]
    fn tool_annotations_match_broker_side_effects() {
        let orchestrator = tool_definitions("orchestrator", "balanced", None);
        let annotation = |name: &str, key: &str| {
            orchestrator
                .iter()
                .find(|tool| tool["name"] == name)
                .and_then(|tool| tool["annotations"][key].as_bool())
        };

        assert_eq!(annotation("peers_list", "readOnlyHint"), Some(true));
        assert_eq!(annotation("delegation_result", "readOnlyHint"), Some(true));
        assert_eq!(annotation("delegation_status", "readOnlyHint"), Some(false));
        assert_eq!(annotation("delegate_start", "readOnlyHint"), Some(false));
        assert_eq!(annotation("delegation_stop", "destructiveHint"), Some(true));
        assert_eq!(
            annotation("skill_data_request", "openWorldHint"),
            Some(true)
        );
        assert_eq!(annotation("peers_list", "openWorldHint"), Some(false));
    }
}
