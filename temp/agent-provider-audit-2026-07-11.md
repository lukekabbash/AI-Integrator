# Agent provider audit handoff

Date: 2026-07-11
Repository: `H:\Code\integrator-3`

This is a local-first supervisor for vendor coding-agent CLIs. It does not
create provider accounts, proxy model traffic, or require application API
keys. Vendor logins and credentials stay inside each installed CLI.

## Naming and launch decisions

- **Grok Build** is the runtime/product name. `grok` is the executable.
- Grok Build's ACP entrypoint is `grok agent stdio`.
- Cursor's current primary executable is `agent`; `cursor-agent` is a
  backward-compatible alias. Cursor ACP is launched with the `acp` subcommand.
- Gemini CLI's documented ACP entrypoint is `gemini --acp`.
- Codex is not an OpenAI API integration here. It is the local `codex
  app-server` JSON-RPC process.
- Claude Code remains a user-owned structured CLI path in the current product
  boundary, not an AI Integrator account/login connector.

## Model and reasoning decisions

- Codex: discover the current account/build catalog through app-server
  `model/list`; preserve `supportedReasoningEfforts` order and pass the
  selected model/effort through the app-server thread/turn surface.
- Cursor: discover Composer 2.5, provider models, and open-weight models from
  the ACP `session/new` response's stable `configOptions`. Use the `model`
  option and `thought_level` option with `session/set_config_option`. Do not
  rely on the non-portable `cursor/list_available_models` extension or hard-
  code account-entitled model IDs.
- Grok Build: use ACP plus `grok models`, `--model`, and `--effort` only on
  the CLI fallback path. Keep `grok-4.5`/the installed Grok Build model
  account-visible and dynamically discovered when possible.
- Claude Code: preserve model IDs exposed by Claude Code, including the
  current documented Opus 4.8, Fable 5, Sonnet 5, and Haiku 4.5 examples;
  use vendor effort controls rather than parsing model-name suffixes.

## Chain-of-thought boundary

Persist only provider-labeled reasoning summaries and observable activity.
Never persist raw hidden reasoning/thinking content in task handoffs, audit
payloads, or provider-neutral context. Never reconstruct chain-of-thought from
tool events or deltas.

## First-party sources reviewed

- OpenAI Codex app-server: <https://learn.chatgpt.com/docs/app-server>
- OpenAI Codex app-server source README:
  <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>
- Cursor CLI changelog/model surface:
  <https://cursor.com/changelog/cli-jan-08-2026>
- Cursor Composer 2.5:
  <https://cursor.com/changelog/composer-2-5>
- Cursor model catalog:
  <https://docs.cursor.com/models>
- xAI Grok Build overview:
  <https://docs.x.ai/build/overview>
- xAI Grok Build CLI reference:
  <https://docs.x.ai/build/cli/reference>
- Anthropic Claude Code CLI reference:
  <https://docs.anthropic.com/en/docs/claude-code/cli-usage>
- Anthropic Opus 4.8:
  <https://www.anthropic.com/news/claude-opus-4-8>
- Anthropic Fable 5:
  <https://www.anthropic.com/news/claude-fable-5-mythos-5>
- Anthropic Sonnet 5:
  <https://www.anthropic.com/news/claude-sonnet-5>
- Gemini CLI ACP mode:
  <https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md>
- Stable ACP session configuration:
  <https://agentclientprotocol.com/protocol/session-config-options>

## Implementation status

- Completed: provider discovery prefers Cursor `agent` and probes Grok with
  `grok version`.
- Completed: Cursor model discovery uses stable ACP `configOptions`; the
  non-portable `cursor/list_available_models` extension is not used.
- Completed: Cursor model and thought-level changes use
  `session/set_config_option`.
- Completed: Codex `model/list` is authoritative and stale demo labels were
  updated.
- Completed: raw ACP thought chunks and raw Codex reasoning content are not
  persisted; provider summaries remain available.
- Completed: both Codex app-server and ACP transports send the required
  `initialized` notification after the initialize response.

## Remaining verification work

- Add explicit reconnect, cancellation-race, and adversarial provider
  fixtures beyond the current catalog and CoT-boundary tests.
- Full Rust check/test remains environment-blocked until the Windows MSVC
  linker (`link.exe`) is installed; frontend tests and static checks pass.

## Verification snapshot

- `npm --prefix apps/desktop run test`: 9 files, 42 tests passed.
- `npm --prefix apps/desktop run check`: passed.
- `npm --prefix apps/desktop run lint`: passed.
- `npm --prefix apps/desktop run format`: passed.
- `npm run check:bridge`: passed.
- `npm run check:docs`: passed.
- `cargo fmt --all -- --check`: passed.
- `cargo check`/`cargo test`: blocked before project compilation because this
  session has no MSVC `cl.exe`/`link.exe` toolchain.
