# Canonical documentation update map

**Target:** this repository root
**Purpose:** integrate the v1 decisions without creating duplicate authority.

## 1. New canonical documents

Copy these documents into the target `docs/` directory and add them to `README.md`:

| Source in this package | Canonical name | Owns |
|---|---|---|
| `v1-scope.md` | `docs/v1-scope.md` | definitive v1 in/out scope, milestones, release gates |
| `architecture.md` | `docs/architecture.md` | one-codebase runtime/release architecture |
| `local-first-contract.md` | `docs/local-first-contract.md` | identity, backend, storage, network, privacy, portability |
| `design-system-contract.md` | `docs/design-system-contract.md` | current visual/navigation/customization decisions |

The large product/catalog documents link to these for authoritative decisions and retain their detailed behavior/tests.

## 2. Existing-document patches

### `README.md`

- Opening: state one Windows/macOS product, local-first/accountless, no required Integrator service.
- Add the four new canonical documents to the index.
- Launch statement: Codex app-server and Cursor ACP are certified v1 gates; additional ACP agents are capability-gated Preview until certified.
- Clarify “pays for” means vendor subscriptions/accounts remain vendor-owned.

### `docs/product-spec.md`

| Current area | Required change |
|---|---|
| Header/platforms, lines 3–7 | Replace Windows-first/macOS-second with one Windows/macOS product and release train. |
| Executive summary, lines 9–21 | Add no signup/backend/cloud-sync/credential-proxy/required-telemetry promise. |
| Goals/non-goals, lines 43–69 | Make both platforms a v1 goal; add account/backend/IDE/runtime-installer non-goals. |
| Domain model, lines 105–150 | Add `LocalInstallation`, `LocalProfile`, and `RuntimeConnection`; remove implied Integrator Account/Workspace identity. |
| Information architecture, lines 152–200 | Make Settings a full-screen route whose category navigation replaces project/task navigation. |
| Adapter/local services, lines 590–649 | Freeze embedded Rust supervisor/broker, local stdio/typed IPC, no inbound/LAN service, no renderer shell authority. |
| Usage, lines 653–670 | Standardize provider %, tokens, API-equivalent value, actual spend, source/freshness. |
| Credentials/policy, lines 729–752 | Use optional signed managed-machine policy → local user → project → task → parent → child → runtime sandbox. |
| Scope, lines 833–884 | Replace MVP/Beta/Later with links to `v1-scope.md`; remove macOS from Beta and backend-shaped roadmap items. |
| Metrics, lines 886–913 | Metrics are local counters/user research; no required product telemetry. |
| Decisions, lines 915–937 | Close Tauri decision and link to architecture spike/fallback rule. |
| Acceptance, lines 939–996 | Add no-account, both-platform, export/import, signing/notarization/update/rollback, theme, Git-rail, and local-data gates. |

### `docs/delivery-criticality-matrix.md`

- Replace Windows-first/macOS-Beta language with one v1 platform gate.
- Promote settings/theme export/import, local task export, data-location, migration, and uninstall choice to v1.
- Resolve child/orchestration contradiction: one-level delegation and child supervision are v1.
- Reclassify QOL 171/176–180 for local multi-window/runtime behavior; remove presence/recipient/device/account-sync interpretations.
- Make the matrix reference `v1-scope.md` for delivery phase and retain criticality only for applicable features.

### `docs/ui-ux-primitives.md`

| Area | Required change |
|---|---|
| IA, lines 405–419 and 485–497 | Full-screen Settings route; category rail replaces project rail; no Account/Billing UI. |
| Review, lines 1426–1436 | Require red/green plus non-color diff semantics and syntax/context layering. |
| Connections, lines 1777–1868 | Say vendor runtime connection/auth context, not Integrator account. |
| Usage, lines 1872–1904 | Require the separate usage dimensions and provenance contract. |
| Tokens, lines 2038–2150 | Remove magenta/purple semantics, add 12 presets, font controls, semantic tokens, softer 8–12 px radii. |
| Platform, lines 2517–2554 | Both Windows and macOS are v1; retain platform-native behavior behind common semantics. |
| Recovery/state, lines 2597–2657 | Replace backend/server sync language with local supervisor/runtime/adapter/producer. |
| Implementation sequence, lines 3020–3064 | Put one-level orchestration in v1; link to v1 milestones. |

Add right-rail Git behavior: the rail owns status/commit draft/file groups/history; selected diff opens in the primary canvas.

### `docs/user-stories.md`

- First run has no Integrator signup. It detects vendor runtimes or opens official setup flows.
- Replace team-admin launch persona with solo local user; managed-machine policy is optional and local.
- Add Settings route/back restoration, theme/font customization, right-rail Git, usage provenance, local export/import/data deletion/uninstall stories.
- Remove hosted-service success assumptions and backend-shaped expansion from the v1 roadmap.

### `docs/qol-100.md`

- Rewrite 171 as local per-window read state.
- Rewrite 176 as local multi-window control lease.
- Rewrite 177 as local runtime handoff or explicit task export.
- Remove recipient/presence behavior from 178's current product boundary.
- Rewrite 179 as narrow-window desktop safety.
- Rewrite 180 as vendor-runtime auth-context switching with cache separation, not Integrator account switching.
- Replace “backend reality” with local supervisor/runtime truth where applicable.

### `docs/broker-mcp-contract.md`

- Session scope: `localInstallation`, `localProfile`, `project`, `task`, `parentRun`, `policySnapshot`, `controlLease`.
- v1 transport: local stdio/process-bound only; no remote HTTP listener.
- `account` appears only as `vendorAuthContext` where needed to prevent runtime-session mixing.
- Preserve Broker tool scope and transcript/redaction rules.

### `docs/repo-coordination-protocol.md`

- Replace Integrator account/workspace authorization with local installation/project/task/run/control-lease terminology.
- Add versioned task export/import rules and explicit no-sync behavior.
- Keep Git-common ledger, run-owned scratch, reference-before-copy, and transcript range contracts unchanged.

### `docs/critical-systems-primitives.md`

- Replace account ownership with local-installation/project/vendor-auth-context isolation.
- Both platform packages require publisher identity, signed installers, notarization where applicable, signed updates, rollback, and compatibility metadata.
- Feature kill/compatibility data may be static signed metadata; no hosted account/backend dependency.
- Add local-data export/delete/uninstall and no-telemetry-by-default acceptance fixtures.

### `docs/integration-manifest.example.yaml`

Required top-level additions/changes:

```yaml
product_platforms: [windows, macos]
application_identity: local_installation
requires_integrator_account: false
requires_integrator_backend: false

runtime:
  shell: tauri_2
  core: rust
  ui: react_typescript
  renderer_shell_access: false

broker:
  transport: local_stdio
  inbound_network_listener: false
  session_scope:
    [local_installation, local_profile, project, task, parent_run, policy_snapshot, control_lease]

usage_dimensions:
  [provider_allowance, tokens, api_equivalent_value, actual_incremental_spend]
usage_sources: [vendor_exact, local_observed, estimated, unavailable]
```

Add per-runtime Windows/macOS certification/version floors and keep the file explicitly illustrative until backed by JSON Schema/generated types.

### `docs/research-and-design-principles.md`

- Synchronize no-purple default semantics, softer radius tokens, 12 presets, font customization, Settings route, and right-rail Git.
- Require the same critical user flows on Windows and macOS.
- Treat the approved mockups as direction/evidence, not implementation gospel.

## 3. Terminology migration

Apply consistently:

| Avoid for v1 | Use |
|---|---|
| AI Integrator account | local installation / local profile |
| AI Integrator workspace | project or task collection |
| backend | embedded local supervisor, runtime, adapter, producer, or vendor service—whichever is true |
| account switch | vendor runtime auth-context switch |
| sync | local state reconciliation unless a named vendor sync is meant |
| cost | actual spend or API-equivalent estimate |
| quota | named provider allowance/window with provenance |
| native app per OS | one native-installed product with OS-specific artifacts |

## 4. Contradictions this merge must remove

1. Windows MVP versus macOS Beta.
2. No app account versus Broker/account authorization fields.
3. Local-first versus presence/recipient/device-revocation/remote-sync behaviors.
4. Delegation in MVP versus orchestration in P2.
5. Settings page in canvas versus right drawer/sidebar concepts.
6. Blue/neutral product language versus magenta Plan tokens.
7. “Usage” as one number versus independent percentage/token/equivalent/actual measurements.
8. No backend versus success metrics that silently require telemetry ingestion.
9. Shareable local product versus settings/task export deferred to Beta.

## 5. Documentation validation after merge

Run automated checks for:

- all local Markdown links and anchors;
- balanced fences and parseable JSON/YAML examples;
- unique numbered headings and primitive ids;
- stale terms: `Windows first`, `macOS Beta`, `Integrator account`, `Organization policy`, `purple`, `magenta`, `backend reality`, `remote sync`, `recipient`, `presence`;
- runtime manifest against its schema;
- exact v1/Beta/Later references matching `v1-scope.md`;
- every v1 feature mapped to owner, dependency, schema, fixtures, platform matrix, security tests, and release gate.

## 6. Implementation readiness checklist

Implementation may start when:

- [ ] Canonical repository is initialized with branch/CI/license/contribution/release structure.
- [ ] These docs are merged and contradictions above return zero stale hits.
- [ ] Architecture ADR and minimum OS/architecture/signing-key decisions are approved.
- [ ] Versioned schemas/generated Rust and TypeScript types exist for core records and adapter manifests.
- [ ] Threat model, vendor wrapping/branding review, privacy statement, and dependency/license policy are written.
- [ ] Sanitized Codex/Cursor replay corpus and fake adapter exist.
- [ ] Tauri/PTY/Git/recovery/accessibility/packaging spike passes on Windows and macOS.
- [ ] M1 tickets map to v1 acceptance fixtures; non-v1 primitives do not accidentally gate release.
- [ ] Interactive prototypes for the nine design acceptance states are approved.
