# ACP runtime onboarding

First-class ACP runtimes share one protocol boundary, but installation, authentication, and truthful capability discovery remain vendor-specific. This checklist keeps a new runtime narrow, reversible, and honest.

## Required decisions

1. Add one `ProviderKind`, wire id, display name, discovery definition, and setup-terminal route. Keep credentials in the vendor CLI; never read or copy token contents into Integrator.
2. Record the exact executable and ACP arguments as arrays. Do not route renderer-supplied shell text through the native process boundary.
3. Authenticate only through an ACP-advertised method or a documented vendor command. If there is no safe status command, report that auth is verified during the ACP handshake.
4. Treat `session/new`, `session/load`, and later `config_option_update` snapshots as authoritative for models, modes, and thought controls. Static model ids are degraded setup fallbacks only.
5. Reuse the standard ACP task state in `bridge.ts`: connection, session, delegation binding, selected config, resume reference, and reset behavior. Add a provider-specialized branch only for a real protocol extension.
6. Project the local MCP broker through `session/new`. Pass harness instructions only when the provider explicitly supports that surface.
7. Map read-only children to the provider's advertised Ask or Plan mode and writing children to Agent or Default. Never infer that Auto or YOLO is an ordinary project-write mode.
8. Certify session recovery and MCP transports from the live ACP handshake. Missing capabilities stay visible as degraded rather than being filled in from marketing claims.
9. Test discovery order, launch arguments, login/update commands, mode parsing, model/thought parsing, routing application, delegation changes, reconnect, cancellation, and malformed or missing capability snapshots.

## Grok Build record

Implemented against Grok Build CLI 1.0.3 and the official xAI Build / reasoning docs on 2026-08-12.

- Install: official PowerShell/bash installer to `~/.grok/bin`; npm package `@xai-official/grok`.
- Update: `grok update`.
- Login: vendor `grok login` / browser / device auth. Discovery asks `grok --no-auto-update models` and parses the login sentence (`You are logged in with grok.com.`). Integrator does not read `~/.grok/auth.json` or `config.toml`.
- Launch: `grok --no-auto-update agent --no-leader --always-approve [--model <id>] [--reasoning-effort <level>] stdio`. Chat omits `--always-approve` and uses `--permission-mode dontAsk`. Grok applies `cached_token` during `initialize` (`defaultAuthMethodId`); Integrator does not send ACP `authenticate` or `initialized` when that default is already selected. Logged-out agents that omit `cached_token` still require `grok login`.
- Models: live ids from `grok models` (`*` default and `-` siblings). ACP `initialize` / `session/new` `_meta.modelState.availableModels` is authoritative when present. Degraded fallback ids are `grok-4.6` and `grok-4.5`.
- Effort: documented menus only — `grok-4.6` exposes `low` / `medium` / `high` / `xhigh`; `grok-4.5` exposes `low` / `medium` / `high`. Current ACP does not advertise mutable `configOptions`, so route changes relaunch with flags and resume the bound session.
- Modes: Grok ACP does not advertise session modes. Chat isolation is launch-flag and env based (`--tools ""`, `--no-memory`, compatibility scanners off).

Primary sources: [Grok Build overview](https://docs.x.ai/build/overview), [CLI reference](https://docs.x.ai/build/cli/reference), [headless / ACP](https://docs.x.ai/build/cli/headless-scripting), [reasoning effort](https://docs.x.ai/developers/model-capabilities/text/reasoning), and [models](https://docs.x.ai/developers/models).

## Kimi Code record

Implemented against the current Moonshot `kimi-code` TypeScript runtime and its official documentation on 2026-07-17.

- Install: official shell/PowerShell installer; npm package `@moonshot-ai/kimi-code`; Homebrew formula `kimi-code`.
- Update: `kimi upgrade`.
- Login: `kimi login`; ACP advertises auth method `login`. Integrator does not inspect Kimi credential files.
- Launch: `kimi acp` over local stdio.
- Models: negotiated from the ACP `model` config option. Setup fallback ids are `kimi-code/k3`, `kimi-code/k3-256k`, `kimi-code/kimi-for-coding`, and `kimi-code/kimi-for-coding-highspeed`.
- Modes: `default`, `plan`, `auto`, and `yolo`, negotiated from the ACP `mode` config option.
- Thinking: negotiated from the `thought_level` config option. Current ACP exposes `off`/`on`, or a locked `on` for always-thinking models.
- Outside ACP, K3 documents low, high, and max reasoning: `minimum`/`light` map to low, `medium` maps to high, `xhigh`/`ultra` map to max, and `none` disables thinking. Those values are intentionally not sent through ACP today. The adapter currently hides that granularity and selects the model default internally; presenting them in Integrator would create controls with no protocol effect. If Kimi advertises multiple thought values later, the generic parser will surface them without a Kimi-specific UI list.
- MCP: stdio, HTTP, and SSE are negotiated; filesystem reverse RPC is supported. Terminal reverse RPC is not advertised.

Primary sources: [Kimi Code documentation](https://www.kimi.com/code/docs/en/), [models](https://www.kimi.com/code/docs/en/kimi-code/models.html), [ACP integration](https://www.kimi.com/code/docs/en/guides/ides.html), and [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code).

## Remaining simplification opportunities

- Move provider metadata (name, executable, version command, ACP arguments, install sources, and static degraded models) into one typed native registry, then generate renderer labels from the serialized projection.
- Generalize live catalog probing so every ACP runtime can negotiate settings without borrowing an active chat task.
- Store config-option ids per session rather than per runtime. This matters if two concurrent sessions receive different model catalogs.
- Replace the illustrative YAML manifest with a validated, signed built-in registry only after its renderer/native privilege boundary is specified and tested.
