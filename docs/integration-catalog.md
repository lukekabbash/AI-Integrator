# Integration catalog

**Product:** AI Integrator  
**Last source review:** 2026-08-12
**Purpose:** Make provider-adapter implementation possible without rediscovering install, login, protocol, session, permission, usage, and policy details.

This is an implementation notebook, not a promise that every vendor surface is stable or contractually available. Commands and protocol fields must be re-probed against the installed version during adapter startup. Do not copy credentials out of a vendor's store, synthesize private APIs, or call a consumer web endpoint when an official CLI, ACP server, SDK, or app-server exists.

## 1. Integration strategy

### 1.1 Launch order

| Priority | Runtime | Primary path | Why |
|---|---|---|---|
| P0 | Codex | `codex app-server` | Richest documented client protocol: login, models, threads, turns, steering, approvals, typed items, review, usage, skills, and subagents. |
| P0 | Cursor Agent | `agent acp` (`cursor-agent` compatibility alias) | First-class product requirement and the current Cursor CLI entrypoint; model/config discovery is ACP-negotiated. |
| P0 | Grok Build | `grok agent stdio` | Grok Build is the product/runtime name; `grok` is only the executable. Native ACP, browser or API-key auth, models, effort, sessions, worktrees, skills, plugins, and structured fallback. |
| P1 | Generic ACP | Official ACP registry + custom command | One adapter unlocks Copilot, Gemini, Kilo, OpenCode, Cline, Goose, Qwen Code, and other registered agents. |
| P1 | GitHub Copilot CLI | `copilot --acp` | Broad subscription footprint, official ACP server, multi-model picker, sessions, permissions, skills, and GitHub context. |
| P1 | OpenCode or Kilo | Native ACP | Open source, multi-provider, strong session/model/usage surfaces, useful reference implementations. |
| Restricted | Claude Code | User-enabled local command skill only | Strong product primitives, but Anthropic explicitly disallows third parties from offering Claude.ai login or routing Free/Pro/Max credentials for users. |
| P2 | Structured CLI / PTY | JSONL, then terminal emulation | Compatibility path for Aider and runtimes without an adequate client protocol. |

### 1.2 Adapter fidelity levels

| Level | Transport | What the UI may promise |
|---|---|---|
| A | Rich vendor protocol | Typed sessions, turns, item streams, approval round trips, steering, cancel, models, usage, and native subagent identity when exposed. |
| B | ACP | Negotiated ACP capabilities only: session/prompt/cancel, updates, permissions, file and terminal requests, models and modes where advertised. |
| C | Structured process | Typed or normalized event stream, terminal result, session ID if emitted, coarse predeclared permissions. |
| D | PTY | Faithful terminal transcript and keyboard input; no claim of typed events, safe approvals, accurate tokens, or portable sessions. |

Never make a Level C or D runtime look like Level A. A generic “Working” line is safer than a fabricated tool card.

## 2. ACP as the common extension layer

ACP is the Agent Client Protocol: a JSON-RPC protocol between an agent and an interactive client. Protocol version compatibility is negotiated during `initialize`; package or schema versions are not the wire version. The current stable wire protocol is version `1` as of this review.

The client implementation must support at least:

- `initialize` first, followed by capability-driven UI.
- Agent authentication methods returned during initialization.
- `session/new`, optional session load/fork behavior, and stable session IDs.
- `session/prompt` with streamed `session/update` notifications.
- `session/cancel` and a visible cancellation terminal state.
- Agent-to-client permission requests with allow-once, reject, and supported persistent options.
- Client file reads/writes and terminal creation/output only inside the selected workspace and active permission profile.
- Content blocks and tool-call updates without assuming every agent uses identical types.
- Model and mode selection only when advertised.
- Unknown fields and extension methods without crashing.
- Process death, malformed JSON, stalled handshakes, and unsupported capability fallback.

Use the official registry index rather than maintaining download URLs by hand:

```text
https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
```

Registry entries include identity, version, authors, license, platform distributions, launch command/arguments, and authentication conformance. Cache the last valid index, retain its retrieval time and digest, and require explicit confirmation before installing or updating an executable.

Primary sources:

- [ACP specification and SDKs](https://github.com/agentclientprotocol/agent-client-protocol)
- [ACP registry](https://agentclientprotocol.com/registry)
- [ACP registry repository](https://github.com/agentclientprotocol/registry)

## 3. Authentication ownership

AI Integrator is a client and process supervisor, not a credential broker.

1. Prefer an official protocol login method when the protocol explicitly supports it.
2. Otherwise launch the vendor's own login command in a clearly branded terminal or browser flow.
3. Store only connection metadata: runtime ID, executable path, detected account label if the runtime returns one, auth status, and last successful probe.
4. Never read, copy, log, upload, or migrate vendor token files.
5. Never accept a secret in a normal task prompt. API keys go through OS credential storage or a vendor-owned setup flow.
6. Redact environment values, CLI arguments that match secret patterns, auth URLs after use, headers, and raw protocol fields marked sensitive.
7. Logout is always the vendor's operation and must explain whether it affects other native clients.
8. A UI button reading **Use existing login** means “ask the installed runtime whether it is logged in,” not “import credentials.”
9. A healthy existing login proceeds directly to capability/compatibility probing. A logged-out interactive runtime may run its official command in a dedicated user-owned Setup terminal; its password/no-echo/MFA input is never model-visible or persisted.

## 4. Launch capability matrix

| Runtime | Native client protocol | Structured fallback | Login/status | Sessions | Models/effort | Permissions | Usage |
|---|---|---|---|---|---|---|---|
| Codex | App-server JSON-RPC | `codex exec --json`, PTY | App-server account API; `codex login` | Start/read/list/resume/fork/archive/delete | Model list, effort and service tier | Bidirectional approvals and sandbox profiles | Turn usage, rate limits, account usage |
| Cursor | ACP | `-p --output-format stream-json`, PTY | `agent login`, `agent status`, `agent logout`; API key | `ls`, `resume`, `--resume` | `agent models`; ACP `configOptions` for model and thought level | ACP when advertised; CLI allow/deny config otherwise | Treat as unknown unless protocol/result reports it |
| Grok Build | ACP | `-p --output-format streaming-json`, PTY | Browser login, `grok login`, device auth, `XAI_API_KEY` | Resume/continue/fork, sessions list/search/delete | `--model`, `--effort`, custom model config | ACP permissions; allow/deny/sandbox flags | Capability-probe; never infer subscription quota |
| Copilot CLI | ACP | Programmatic JSON/JSONL | `copilot login`; token env vars | Resume/continue; SDK session APIs | Model and reasoning effort | ACP or allow/deny tool rules | Capability-probe and preserve vendor billing labels |
| Gemini CLI | ACP registry path | `gemini -p --output-format stream-json` | First-run Google login or `GEMINI_API_KEY`/Vertex | Session ID in events; CLI resume support must be probed | CLI/config model selection | ACP or headless policy flags | JSON result includes statistics and per-model tokens |
| Kilo | ACP | `kilo run`, server/API, PTY | `/connect`; `kilo auth` | Native session commands and export/import | Provider/model and agents | ACP plus agent permission lists | `kilo stats` |
| OpenCode | ACP | `opencode run --format json`, HTTP/SSE server | `opencode auth login/list/logout` | List/delete, continue/session/fork, export/import | Provider/model, variants, agents | ACP or policy config | `opencode stats` |
| Cline | ACP | `--json`, headless, PTY | `cline auth` | `cline history`; capability-probe ACP | Provider/model flags | ACP plus env policy | Capability-probe |
| Goose | ACP | CLI/API | Provider configuration owned by Goose | Capability-probe | Multi-provider | ACP | Capability-probe |
| Kiro CLI | ACP | `chat --no-interactive` | `login/logout/whoami`, device flow, `KIRO_API_KEY` | ACP sessions | ACP models/modes | ACP or trusted-tool categories | Subscription credits; use only returned data |
| Qwen Code | ACP registry path | `qwen -p --output-format stream-json` | First-run API key or Coding Plan | Continue/resume | CLI/config models | ACP or approval/sandbox flags | JSON result statistics |
| Claude Code | Not a launch integration | User-configured local skill; `-p --output-format stream-json` | Vendor CLI only; never offer Claude.ai login | Continue/resume/fork | Model and effort | Vendor CLI only | JSON can report cost/usage; subscription rules apply |
| Aider | None documented | One-shot/PTY | API keys owned by Aider/provider | PTY conversation | `--model` | Terminal interaction | Estimated/vendor API only; label carefully |

### 4.1 Execution-route and delegation capability contract

The lower-right composer selector is driven by adapter data, not a hard-coded provider list. Every selectable route must resolve or explicitly mark unknown:

```text
connection/account label
runtime/harness id and version
provider model id and display name
service tier and reasoning/effort options
billing/usage class and confidence
context capacity/pressure support
native session continuation behavior
permission/tool/file/terminal/review/browser/subagent/worktree capabilities
availability, last probe, and compatibility state
```

An adapter contributing delegation peers must additionally declare native/brokered/unsupported spawning, role support, maximum enforceable depth/concurrency/runtime, child configuration overrides, permission inheritance, worktree isolation, child control/resume, usage attribution, and result/evidence fidelity. Missing enforcement makes the route ineligible for automatic delegation; it does not become an advisory rule.

Cross-runtime agent calls use the [Broker MCP contract](broker-mcp-contract.md). Shared task notes, run scratch, messages, transcript references, worktree leases, and Git UI identity use the [Repository coordination protocol](repo-coordination-protocol.md); adapters must not create private competing copies.

### 4.2 Provider-native skill and slash-action contract

The composer must source `/` suggestions from the selected runtime rather than
from generic prompt shortcuts:

- Codex uses app-server `skills/list`; invocation includes Codex's typed
  `{type:"skill", name, path}` input. Skill paths remain in the native host and
  the renderer returns only an opaque selection id. `/goal <objective>` uses
  `thread/goal/set` with active status, then starts the first turn with that
  same objective; it is a command, not a synthetic skill.
- ACP runtimes use the full replacement from
  `available_commands_update`; invocation remains the exact advertised
  `/<name> [args]` text in `session/prompt`. ACP does not distinguish built-in
  commands from skills, so Integrator must not invent that distinction.
- Claude Code has no headless inventory endpoint. The native host performs a
  bounded metadata-only scan of documented personal, project, legacy-command,
  and plugin roots, merges the current bundled catalog, and preserves
  the slash token at byte zero. `/goal` is direct because Claude supports it in
  print mode; session-resident actions such as `/loop` remain interactive-only
  until the adapter owns a persistent Claude process.
- Antigravity skill metadata may be discovered from its provider-owned roots,
  but the current print-mode route is not a slash-command transport. Those
  rows are labeled interactive-only; they must never be sent as ordinary model
  prose while claiming native execution.
- Grok uses `grok --no-auto-update agent --no-leader --always-approve stdio`
  (Chat omits `--always-approve` and locks tools with `--permission-mode dontAsk`);
  model and effort are agent flags (`--model`, `--reasoning-effort`) so a route
  change relaunches. Before `session/new`, the ACP
  adapter may select only the provider-advertised `cached_token` auth method.
  It never reads, accepts, or proxies an xAI API key. Current Grok Build ACP
  initialization does not advertise mutable model or thought-level config
  options, so Integrator discovers model ids with the documented `grok models`
  probe and applies model/effort through process-launch flags. Changing either
  route starts a fresh Grok process and resumes the bound provider session
  through ACP instead of pretending an in-place config update succeeded.

Catalog metadata is untrusted and bounded. Refresh replaces old opaque ids,
and execution revalidates the selected action against the same canonical
trusted repository before dispatch. The composer may prefetch and retain a
catalog for responsiveness because dispatch-time revalidation remains the
authority.

An unchanged provider action retains its opaque id across catalog refreshes;
only a changed or removed action invalidates the handle. If Codex definitively
reports that a stored thread or rollout no longer exists, Integrator forgets
that native id, starts one replacement thread, and retries the not-yet-started
turn once. Other provider errors are not replayed automatically.

Composer and transcript emphasis is also catalog-backed. An exact direct
action with `kind: skill` may render its leading `/name` token in the semantic
skill style; commands and unknown slash text remain plain. The renderer sends
only the opaque action id, while the native host derives and persists the
verified skill name on the user item so the distinction survives restart and
cannot be forged by ordinary message text.

## 5. Runtime records

### 5.1 Codex — launch P0

**Install and start**

```powershell
npm install -g @openai/codex
codex --version
codex login
codex app-server
```

The app-server defaults to JSONL over stdio and uses JSON-RPC-shaped messages without a `jsonrpc` field on the wire. Generate schemas from the exact installed build:

```powershell
codex app-server generate-ts --out .\generated\codex
codex app-server generate-json-schema --out .\generated\codex
```

**Why it is primary:** The protocol covers thread start/resume/fork/read/list/archive/delete, turn start/steer/interrupt, typed item lifecycle, streamed agent messages, plans, reasoning, commands, file changes, MCP and dynamic tools, collaboration calls, review mode, approvals, skills, models, account login/logout, rate limits, and usage.

**Implementation notes**

- Start one supervised app-server process per host identity, not one per task, unless isolation testing shows otherwise.
- Send `initialize`, then `initialized`, before all other requests.
- Treat `item/completed` and `turn/completed` as authoritative; deltas are presentation data.
- Render `reasoning.summary` when supplied. Render raw `reasoning.content` only when delivered and policy permits; never reconstruct hidden chain of thought.
- Map `collabToolCall` IDs and parent/child thread IDs into the subagent tree.
- Use `turn/steer` for mid-run user messages and `turn/interrupt` for stop.
- Use app-server account methods for login UI and usage; do not parse `auth.json`.
- Prefer stable methods. Gate experimental fields behind a versioned feature flag.

Sources: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [configuration](https://learn.chatgpt.com/docs/config-file/config-reference), [permissions](https://learn.chatgpt.com/docs/sandboxing), [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [CLI commands](https://learn.chatgpt.com/docs/developer-commands).

### 5.2 Cursor Agent — launch P0

**Installed CLI path**

```bash
curl https://cursor.com/install -fsS | bash
agent --version
agent login
agent status
agent acp
```

`agent` is the current primary Cursor CLI command. `cursor-agent` remains a
backward-compatible alias and must be accepted during discovery when it is the
only installed executable.

The older standard install page names macOS, Linux, and Windows through WSL. The ACP registry snapshot reviewed on 2026-07-10 also provides native Windows x64 and arm64 packages and launches them with `cursor-agent acp`. The adapter must test native Windows end to end before marketing it as supported; registry availability alone is not enough.

**Structured fallback**

```bash
cursor-agent -p "Explain this repository" --output-format stream-json
cursor-agent ls
cursor-agent resume
cursor-agent --resume="chat-id"
```

`stream-json` is NDJSON with initialization, user, assistant, tool, and terminal result events. Unknown fields are forward-compatible and must be ignored. A failed run may exit without a terminal result object.

**Authentication:** `agent login` opens Cursor's browser flow; `status` checks it; `logout` clears it. Automation can use `CURSOR_API_KEY`. AI Integrator should invoke these commands and never open Cursor's credential files.

**Model and effort selection:** `agent models` is the CLI discovery fallback.
For ACP, prefer the stable `configOptions` returned by `session/new`, with
`category: "model"` for model choices and `category: "thought_level"` for
reasoning choices. Change them with `session/set_config_option`; do not depend
on the removed/non-portable `cursor/list_available_models` extension or invent
model IDs. The negotiated Cursor catalog is authoritative and may include
Composer 2.5, frontier providers, and open-weight models available to that
Cursor account.

**Permissions:** Prefer ACP permission requests. For CLI fallback, preserve Cursor's own allow/deny rules under `~/.cursor/cli-config.json` or `.cursor/cli.json`; do not claim per-tool interactive approval parity unless observed. Do not silently add `--force`.

Sources: [Cursor ACP](https://cursor.com/docs/cli/acp), [CLI overview](https://docs.cursor.com/en/cli/overview), [installation](https://docs.cursor.com/en/cli/installation), [authentication](https://docs.cursor.com/en/cli/reference/authentication), [output schema](https://docs.cursor.com/en/cli/reference/output-format), [parameters](https://docs.cursor.com/en/cli/reference/parameters), [permissions](https://docs.cursor.com/cli/reference/permissions), [Cursor 3.0](https://cursor.com/changelog/3-0).

### 5.3 Grok Build — launch P0

**Install**

```powershell
irm https://x.ai/cli/install.ps1 | iex
grok version
grok login
grok agent stdio
```

The user-facing runtime is **Grok Build**. Keep `grok` only as the literal
binary name in process launch and probe code.

Alternative package install for managed environments:

```powershell
npm install -g @xai-official/grok
```

First launch can open browser authentication. Remote terminals can use `grok login --device-auth`; headless environments can set `XAI_API_KEY` through secure environment injection.

**Fallback and discovery**

```powershell
grok inspect --json
grok models
grok -p "Explain the architecture" --output-format streaming-json
grok sessions list
```

Useful native flags include `--cwd`, `--resume`, `--continue`, `--fork-session`, `--worktree`, `--ref`, `--model`, `--effort`, `--allow`, `--deny`, `--sandbox`, `--max-turns`, `--no-subagents`, and `--no-memory`.

Custom models live in `%USERPROFILE%\.grok\config.toml` on Windows. Read capabilities through commands/protocol; do not edit the user's file unless they explicitly request it.

Sources: [Grok Build overview](https://docs.x.ai/build/overview), [CLI reference](https://docs.x.ai/build/cli/reference), [modes and commands](https://docs.x.ai/build/modes-and-commands), [enterprise deployment](https://docs.x.ai/build/enterprise).

### 5.4 GitHub Copilot CLI — P1

```powershell
winget install GitHub.Copilot
copilot version
copilot login
copilot --acp
```

Cross-platform npm alternative requires Node.js 22 or later:

```powershell
npm install -g @github/copilot
```

Login uses GitHub OAuth device flow and stores the token in the system credential store when available. Headless authentication can use `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`; supported tokens must have Copilot Requests permission.

Copilot provides `--model`, reasoning effort, `--continue`, `--resume`, plan/autopilot modes, skills/plugins, MCP, URL/path/tool allow and deny rules, and an official ACP server. Its SDK also speaks JSON-RPC to the CLI, so it is a useful secondary integration path if ACP lacks a required session primitive.

Sources: [install](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli), [command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference), [programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference), [ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server).

### 5.5 Kilo — P1 generic ACP proving runtime

```powershell
npm install -g @kilocode/cli
kilo auth login
kilo acp
```

Kilo offers a TUI, `kilo run`, ACP, a headless server, web UI, provider/model discovery, agents, sessions, export/import, and `kilo stats`. Its breadth makes it an excellent capability-conformance runtime after the three launch adapters.

Do not confuse Kilo's provider credentials with AI Integrator runtime credentials. Kilo owns provider selection and authentication; the host receives capabilities and events.

Sources: [Kilo CLI](https://kilo.ai/docs/code-with-ai/platforms/cli), [command reference](https://kilo.ai/docs/code-with-ai/platforms/cli-reference), [ACP registry](https://agentclientprotocol.com/registry).

### 5.6 OpenCode — P1 generic ACP and local-server reference

```text
opencode auth login
opencode acp
opencode run "Explain this project" --format json
opencode serve
opencode session list --format json
opencode stats
```

ACP uses nd-JSON on stdin/stdout. `opencode serve` exposes a local OpenAPI HTTP server and server-sent events; protect it with `OPENCODE_SERVER_PASSWORD`, bind to loopback by default, and never expose it to the LAN without explicit configuration. The runtime supports continue/session/fork, models and variants, agents, file attachments, JSON events, exports with `--sanitize`, and usage/cost statistics.

Sources: [CLI](https://dev.opencode.ai/docs/cli/), [server](https://dev.opencode.ai/docs/server/), [ACP](https://dev.opencode.ai/docs/acp/), [providers](https://dev.opencode.ai/docs/providers/).

### 5.7 Gemini CLI — P1 generic ACP/structured runtime

Use the registry package for ACP conformance testing:

```text
npx @google/gemini-cli --acp
```

Structured fallback:

```text
gemini -p "Explain this repository" --output-format stream-json
```

Streaming JSON uses `init`, `message`, `tool_use`, `tool_result`, `error`, and final `result` events; the final event includes aggregated statistics and per-model token usage.

Authentication options are vendor-owned first-run Google login, `GEMINI_API_KEY`, or Vertex AI. Google's terms page explicitly says that directly accessing the services behind Gemini CLI through third-party software using Gemini CLI OAuth violates applicable policies. Therefore AI Integrator may launch the official, unmodified CLI/ACP process and let it own authentication, but must not extract or reuse its OAuth credentials. Obtain legal confirmation before commercial launch.

Sources: [repository](https://github.com/google-gemini/gemini-cli), [installation](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/installation.md), [authentication](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.md), [headless mode](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md), [terms and privacy](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md).

### 5.8 Cline — P1 generic ACP

```powershell
npm install -g cline
cline auth
cline --acp
```

Cline requires Node.js 20 or later. Its CLI also exposes headless prompts, JSON output, provider/model selection, history, MCP, plugins, schedules, a local hub, and command/file permission policies. Current install documentation says native Windows CLI support is still forthcoming, so test under WSL or wait for supported Windows packaging even though the broader product has Windows surfaces.

Sources: [installation](https://docs.cline.bot/getting-started/installing-cline), [CLI reference](https://docs.cline.bot/cli/cli-reference), [ACP integrations](https://docs.cline.bot/cline-cli/acp-editor-integrations).

### 5.9 Goose — P1 generic ACP

```bash
curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash
goose acp
```

Goose is Apache-2.0, local, extensible, multi-provider, and available as desktop, CLI, API, and ACP server. The ACP registry includes Windows x64 packaging. Provider authentication stays inside Goose. It is a strong test for open-source ACP compatibility, terminal requests, and MCP-heavy workflows.

Sources: [Goose](https://block.github.io/goose/), [ACP clients](https://goose-docs.ai/docs/guides/acp-clients/), [repository](https://github.com/block/goose).

### 5.10 Kiro CLI — P1 direct ACP candidate

```powershell
irm 'https://cli.kiro.dev/install.ps1' | iex
kiro-cli login
kiro-cli whoami
kiro-cli acp
```

Kiro supports native Windows, browser or device-code login through Google, GitHub, Builder ID, IAM Identity Center, or an external identity provider. Headless mode uses `KIRO_API_KEY` and `kiro-cli chat --no-interactive`; restrict tools with `--trust-tools` rather than `--trust-all-tools`.

Kiro's ACP docs describe session, prompt, cancellation, load, model/mode, and MCP OAuth events. It did not appear in the ACP registry snapshot used for this document, so add it through an explicitly reviewed custom manifest until it is registered.

Sources: [overview](https://kiro.dev/docs/cli/), [installation](https://kiro.dev/docs/cli/installation/), [authentication](https://kiro.dev/docs/cli/authentication/), [headless mode](https://kiro.dev/docs/cli/headless/), [ACP](https://kiro.dev/docs/cli/acp/).

### 5.11 Qwen Code — P1/P2 generic ACP and structured runtime

```powershell
irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex
qwen
```

The ACP registry launches the npm package with `--acp --experimental-skills`. Structured mode supports JSON and streaming JSON, stdin JSON streams, continue/resume, sandbox/approval settings, and budget limits such as maximum turns, wall time, and tool calls. First run offers API-key or Alibaba Cloud Coding Plan authentication.

Treat the registry's `experimental-skills` flag as unstable and isolate it behind adapter capability/version tests.

Sources: [overview](https://qwenlm.github.io/qwen-code-docs/en/), [quickstart](https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/), [headless mode](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/), [settings](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/).

### 5.12 Claude Code — documented product reference; restricted launch boundary

Useful local CLI probes, owned by the user and Anthropic:

```text
claude auth status
claude -p "Summarize this project" --output-format json
claude -p "Review this change" --output-format stream-json --verbose
claude -p "Continue" --resume <session-id>
```

Claude Code exposes excellent structured automation, sessions, models, effort, permissions, subagents, worktrees, skills, hooks, MCP, and usage. Its JSON result can include `total_cost_usd` and model usage. Starting 2026-06-15, Anthropic documentation says Agent SDK and `claude -p` subscription usage draws from a separate monthly Agent SDK credit.

However, Anthropic's legal documentation says third-party developers must not offer Claude.ai login or route Free, Pro, or Max credentials on a user's behalf. The initial product therefore:

- does not present a built-in Claude account connector;
- does not call `/login`, `claude auth login`, or `claude setup-token` for the user;
- does not inspect `%USERPROFILE%\.claude\.credentials.json`;
- may let a user create an explicit local skill that runs their already-installed command, labeled **User-configured local command**;
- should prefer Anthropic API-key/Agent SDK commercial terms if Claude becomes a first-class product integration.

Sources: [headless mode](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-usage), [authentication](https://code.claude.com/docs/en/authentication), [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Desktop](https://code.claude.com/docs/en/desktop).

### 5.14 Model and reasoning policy

Model availability belongs to the installed vendor runtime, not a global
AI Integrator hard-coded list. The client should display the provider's
negotiated catalog and preserve provider IDs exactly:

| Runtime | Current documented model examples | Correct discovery/selection surface | Reasoning/hidden-thought rule |
|---|---|---|---|
| Codex | GPT-family models, including the model IDs returned by the current Codex build | Local app-server `model/list`; pass the selected `model` and advertised `reasoningEffort` to `thread/start` or the documented turn override | Store/render `reasoning.summary`; never persist raw `reasoning.content` as a handoff or audit payload |
| Cursor Agent | Composer 2.5, Claude Fable/Opus/Sonnet 5, GPT-5.6 Sol/Terra/Luna, Cursor Grok 4.5, and other account-visible frontier models | ACP `session/new` `configOptions`; `session/set_config_option`; `agent models` / static setup ids only as a structured fallback | Use provider-advertised `thought_level` options; do not infer effort suffixes from model names |
| Grok Build | Models returned by the installed CLI (`grok-4.6`, `grok-4.5` on current builds) | `grok models` for live ids and login sentence; ACP `initialize` / `session/new` `_meta.modelState` when a session exists; `--model` and `--reasoning-effort` before `grok agent stdio`; reconnect when the route changes because current ACP does not advertise mutable `configOptions` | Attach a picker only for documented or advertised menus: `grok-4.6` is `low` / `medium` / `high` / `xhigh` (API default `high`); `grok-4.5` is `low` / `medium` / `high`; unknown slugs stay picker-less until ACP advertises `reasoningEfforts`. Never infer subscription quota or expose hidden reasoning |
| Claude Code | `claude-opus-4-8`, `claude-fable-5`, `claude-sonnet-5`, and `claude-haiku-4-5` where the user's Claude Code surface exposes them | User-owned `claude -p` structured CLI; `--model` plus Claude Code's `/effort` control; no AI Integrator account/login path | Do not store raw `thinking`/hidden chain-of-thought events; only retain provider-labeled summaries or observable final/tool activity |
| Gemini CLI | Account/config-visible Gemini models | `gemini --acp` (or the installed CLI's current ACP flag); ACP config options when advertised | Treat thought events as provider content and apply the same raw-thought boundary |

The exact catalog is entitlement- and version-dependent. A model shown in a
vendor announcement is not proof that a particular local CLI account can use
it; a failed or missing catalog must produce a degraded/unknown state rather
than a fabricated model choice.

### 5.13 Aider — P2 PTY/one-shot fallback

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://aider.chat/install.ps1 | iex"
aider --model <provider-model>
```

Aider is a mature terminal pair programmer with broad model/provider support and a browser mode, but no official ACP path was found in this review. Its API keys can come from environment variables, `.env`, CLI flags, or `.aider.conf.yml`; AI Integrator must not ingest those files. Use a PTY or carefully scoped one-shot process and label usage as provider-reported or estimated.

Sources: [installation](https://aider.chat/docs/install.html), [API keys](https://aider.chat/docs/config/api-keys.html), [options](https://aider.chat/docs/config/options.html), [browser mode](https://aider.chat/docs/usage/browser.html).

## 6. ACP registry backlog

The 2026-07-10 registry snapshot also contained Amp, Auggie CLI, Claude Agent wrapper, Codex ACP, Devin, Factory Droid, Mistral Vibe, Kimi CLI, Poolside, Qoder, and other agents. Do not create hand-maintained adapters for these yet. They should appear in an **Experimental agents** catalog sourced from the signed/cached registry and pass the same conformance suite.

Special cases:

- **Codex ACP:** useful as an ACP conformance comparison, but `codex app-server` remains primary because it exposes more Codex-native features.
- **Claude Agent ACP wrapper:** presence in the registry does not override Anthropic's third-party authentication restrictions. Keep disabled in commercial builds until the permitted auth model is confirmed.
- **Cursor:** use the official Cursor-authored registry entry, not a community wrapper.
- **Grok Build:** registry launch is `@xai-official/grok` with `agent stdio`.

## 7. Normalized event contract

Every adapter should map native data into these append-only events while retaining the raw vendor event privately for diagnostics:

```text
runtime.connected
runtime.auth.required | runtime.auth.changed
session.created | session.resumed | session.forked | session.renamed | session.archived
turn.started | turn.steered | turn.cancel.requested | turn.completed | turn.failed
message.delta | message.completed
plan.updated
reasoning.summary.delta | reasoning.block.completed
tool.started | tool.progress | tool.completed | tool.failed
command.started | command.output.delta | command.completed
file.read | file.change.proposed | file.change.completed
permission.requested | permission.resolved
agent.spawned | agent.status.changed | agent.message | agent.completed
artifact.created | artifact.updated
usage.updated | quota.updated
diagnostic.warning
```

Required envelope fields:

```text
event_id, sequence, timestamp, runtime_id, connection_id, project_id,
task_id, native_session_id, native_turn_id, native_item_id,
parent_agent_id, type, payload, fidelity, source, redaction_state
```

Ordering is per native session. The ledger must tolerate duplicate events after reconnect and reconcile final authoritative objects by native ID.

## 8. Conformance suite

An adapter cannot be marked supported until it passes these tests on every advertised OS:

1. Detect missing, installed, outdated, and broken executable states.
2. Report logged-out without reading a credential file.
3. Complete the vendor-owned login/status/logout loop where product policy allows it.
4. Initialize and record negotiated capabilities.
5. Start a session in a path containing spaces and non-ASCII characters.
6. Stream assistant text without duplication or reordering.
7. Show command and file activity with stable IDs.
8. Round-trip allow-once and deny permission decisions.
9. Cancel during thinking, command execution, and idle streaming.
10. Resume after app restart and runtime process restart.
11. Fork where native support exists; otherwise create an explicit provider-neutral handoff.
12. Survive malformed events and unknown fields.
13. Kill the child process tree without leaving background shells.
14. Preserve dirty Git work and refuse unsafe worktree operations.
15. Report usage with a confidence label; show **Unavailable** rather than estimating subscription quota.
16. Produce redacted diagnostics containing no token, auth URL, prompt-secret, or environment value.
17. Populate the full execution-route identity and preserve it through turn, transcript, usage, handoff, and diagnostics.
18. Change model/effort/tier while idle and during a run, proving the documented current/next-turn activation boundary.
19. Apply Off, Ask, and Bounded delegation and prove the adapter/broker cannot spawn outside the effective policy.
20. Exhaust quota/rate/context mid-run and preserve partial work, usage, session, and safe fallback choices.
21. Attach an interactive terminal, arbitrate stdin ownership, handle no-echo input, resize, stop the process tree, and retain exit truth.
22. Detect executable PATH/version drift and select compatible resume, degraded mode, or provider-neutral handoff.
23. Deny secret-file and child-secret access through direct, symlink, alternate-case/path, and environment-inheritance attempts.
24. Retry duplicated/reconnected events and non-idempotent operation fixtures without duplicating external effects.
25. Reuse an existing vendor login, complete a logged-out interactive login in the Setup terminal, and verify no secure input reaches model/transcript/log storage.
26. Resolve the same Git-common coordination root from main checkout and linked worktrees; regenerate ignored run projections without losing task state.
27. Pair a writing child to one lease and prove Files, Terminal, Review, Git, commit, and push target that exact worktree.
28. Round-trip broker parent/child messages and transcript-range grants with redaction, lineage authorization, cursor bounds, and duplicate-request handling.

## 9. Documentation maintenance checklist

At each adapter release:

- Record installed version and protocol/schema version.
- Re-fetch the ACP registry and compare launch metadata.
- Generate vendor schemas when supported.
- Re-run auth, permission, cancel, resume, and unknown-field tests.
- Review terms and authentication guidance for subscription-routing changes.
- Confirm Windows native/WSL behavior separately.
- Update source review date in this document.
- Add a compatibility note rather than silently weakening a feature.

## 10. Documentation index

### Common

- [ACP specification](https://github.com/agentclientprotocol/agent-client-protocol)
- [ACP registry](https://agentclientprotocol.com/registry)

### P0 runtimes

- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Cursor ACP](https://cursor.com/docs/cli/acp)
- [Cursor CLI](https://docs.cursor.com/en/cli/overview)
- [Grok Build](https://docs.x.ai/build/overview)
- [Grok CLI reference](https://docs.x.ai/build/cli/reference)

### P1/P2 runtimes

- [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli)
- [Kilo CLI](https://kilo.ai/docs/code-with-ai/platforms/cli)
- [OpenCode CLI](https://dev.opencode.ai/docs/cli/)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- [Cline CLI](https://docs.cline.bot/cli/cli-reference)
- [Goose](https://block.github.io/goose/)
- [Kiro CLI](https://kiro.dev/docs/cli/)
- [Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/)
- [Claude Code CLI](https://code.claude.com/docs/en/cli-usage)
- [Aider](https://aider.chat/docs/)
