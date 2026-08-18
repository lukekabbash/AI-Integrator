# AI Integrator local-first contract

**Normative v1 boundary:** AI Integrator runs locally and requires no AI Integrator account or application backend.

## 1. What “local-first” means

The following execute/store on the user's computer:

- desktop UI, embedded broker, policy engine, process/PTY supervisor, and adapters;
- task/run state, drafts, settings, capability cache, usage ledger, and search index;
- transcripts or transcript references permitted by the selected vendor/runtime;
- repository inspection, Git status/diff/stage/commit/push orchestration, and worktrees;
- coordination ledger, child messages/results, context manifests, checkpoints, and artifacts;
- terminal scrollback, sanitized diagnostics, and export packages.

ACP normally uses a client-spawned local subprocess and JSON-RPC over stdio. Codex app-server also supports local stdio JSONL. Neither requires an AI Integrator server.

Local-first does **not** mean offline inference. Vendor runtimes still connect directly to their own authentication, model, inference, quota, tool, MCP, and update endpoints under the user's vendor agreement.

## 2. Identity model

AI Integrator has no `Account` or hosted `Workspace` entity in v1.

Use these records instead:

- `LocalInstallation`: installation id, app version, OS user/profile, data schema, device-local settings.
- `LocalProfile`: optional named set of UI/runtime preferences within the installation; never a remote identity.
- `Project`: canonical local path/repository identity and trust state.
- `Task`: durable local unit of work.
- `RuntimeConnection`: vendor/runtime, executable provenance/version, sanitized auth state, vendor-auth-context fingerprint, capabilities.
- `Run`: task/runtime native session identity plus local route/policy/context/worktree state.

The vendor-auth-context fingerprint is non-secret and exists only to prevent accidental cache/session mixing when a user switches a Codex, Cursor, Claude, Grok, or other vendor account.

Broker authorization scope is:

```text
local installation
→ local profile
→ project
→ task
→ parent run
→ child run
→ policy snapshot and control lease
```

Optional signed managed-machine policy may constrain local settings. No organization object or policy backend is required.

## 3. Authentication boundary

- Detect executable/version and run only documented non-secret auth/status probes.
- If already authenticated, reuse the vendor runtime after capability and auth-context probing.
- If signed out, open the vendor's official command in the user-owned Setup terminal or launch its browser/device flow.
- Passwords, API keys, MFA, hardware-key interaction, no-echo input, and vendor token caches never enter the renderer, broker, transcript, coordination ledger, or diagnostics.
- AI Integrator does not copy credentials between vendors or machines.
- Vendor logout/account switching invalidates affected session/capability caches and requires explicit reconciliation.

## 4. Local storage layout

Exact OS directories are selected during implementation, but the logical ownership is fixed:

```text
app data/
  settings + theme overrides
  SQLite task/run/event metadata
  transcript/search indexes
  capability/version cache
  usage ledger
  diagnostics and crash-safe journals
  adapter schemas/fixtures/compatibility metadata

repository .git common directory/
  aiintegrator/v1 task coordination ledger

worktree/
  .aiintegrator/.runtime regenerable ignored projection

optional tracked repository files/
  .aiintegrator/project.yaml
  .aiintegrator/policy.yaml
  .aiintegrator/knowledge/
```

Tracked project knowledge is created/promoted deliberately. Full transcripts, secrets, locks, local runtime state, and noisy scratch are never committed automatically.

## 5. Network inventory

### Required or user-initiated vendor traffic

- vendor authentication/token refresh;
- inference and vendor-hosted agent functions;
- provider model/capability/quota lookups;
- user-approved runtime tools, MCP servers, web search, Git remote operations, or package installation;
- vendor CLI updates initiated through vendor-owned mechanisms.

### AI Integrator distribution traffic

- static signed update metadata and installer download;
- optional user-opened documentation/issues.

### Not present in v1

- Integrator login/account APIs;
- cloud task/transcript database;
- credential/token proxy;
- telemetry ingestion required for use;
- presence/collaboration service;
- remote command relay or mobile-control socket;
- hosted schedules/runners/secrets;
- centralized policy, audit, billing, or pooled budget service.

The app exposes an outbound-network inventory in Settings/Diagnostics with purpose, owner, last use, and controlling policy.

## 6. Offline and degraded behavior

When network/vendor services are unavailable:

- local tasks, history, files, diffs, Git-local actions, worktrees, settings, exports, and prior evidence remain readable;
- the UI distinguishes app connectivity, vendor auth, provider service, Git remote, and tool-specific network state;
- unsent prompts remain drafts or explicitly queued according to runtime capability;
- no operation claims completion without runtime evidence;
- remote-only actions disappear or explain the exact unavailable dependency;
- reconnect reconciles native session, local event sequence, process state, and uncertain actions before retry.

## 7. Portability, deletion, and uninstall

v1 includes:

- show exact application-data and repository-ledger locations;
- export/import versioned settings and themes;
- export a sanitized task package containing contract, messages/results, decisions, evidence references, patches/commits, usage provenance, and optional observable transcript ranges;
- exclude secrets and secure terminal input from every export;
- migration preview and rollback for storage-schema upgrades;
- per-task, per-project, per-browser-identity (one identity per project group, plus Chat and
  Shared; older per-task jars remain clearable), transcript, diagnostics, cache, and all-data
  deletion;
- uninstall choice: keep local data or delete it, with repository-associated files listed separately;
- redacted diagnostics bundle the user explicitly creates and controls.

There is no recipient, share-link, presence, or device-revocation model in v1. Users may transfer an exported package themselves.

## 8. Telemetry and product metrics

- No account or telemetry is required.
- Product health/success counters are calculated locally and shown to the user.
- User research uses explicit interviews or user-supplied redacted diagnostics.
- Automatic crash reporting is off by default. Adding opt-in third-party reporting requires a named processor, exact field inventory, retention, deletion path, and privacy review.
- No prompt, source code, command output, diff, transcript, path, credential metadata, or vendor identity is sent merely to measure product usage.

## 9. Usage provenance contract

Normalized fields:

```text
metric
value + unit
window/bucket id
window start/end/reset
runtime connection + model route
task/run/child
source = vendor_exact | local_observed | estimated | unavailable
source timestamp + freshness
pricing/version basis when estimated
raw provider reference (non-secret)
```

Rules:

- ACP core does not provide a universal usage schema; adapters advertise each field independently.
- Codex can provide plan/rate-limit percentage and reset-window data plus token usage when its app-server capability is present.
- Claude SDK token/cost fields do not prove Claude Pro/Max subscription depletion.
- Cursor stream duration/model/tool data does not imply token, cost, or plan percentage.
- Grok's vendor Settings percentage cannot be scraped or inferred from tokens unless a documented adapter capability supplies it.
- API-equivalent dollars are estimates; actual incremental spend is a separate field.
- Unknown is displayed as `Not exposed`, not zero or unlimited.

## 10. Deferred backend re-architecture

Cross-device sync, team workspaces, RBAC/SSO, hosted schedules, mobile remote control, share links, pooled budgets, cloud secrets, centralized audit, and Integrator billing would create a materially different trust/product architecture. They are not casual roadmap toggles. Any future proposal requires a new threat model, identity/data model, privacy contract, migration/opt-in plan, and independent scope decision.

## 11. Primary sources

- [ACP transports](https://agentclientprotocol.com/protocol/v1/transports)
- [ACP authentication](https://agentclientprotocol.com/protocol/v1/authentication)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Cursor CLI authentication](https://docs.cursor.com/en/cli/reference/authentication)
- [Grok enterprise/local execution](https://docs.x.ai/build/enterprise)
