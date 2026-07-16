# Universal Capabilities Contract (Skills, Plugins, Store)

Status: draft for review. Once accepted, this document is normative alongside
`architecture.md`, `local-first-contract.md`, and `design-system-contract.md`.
It implements delivery-criticality items 109–115 (MVP: portable skills) and
116–120 (Beta: plugin/hook/MCP management), and QOL items 111–120.

## 1. Thesis

A skill is a directory with a `SKILL.md` (the open agentskills.io format).
Integrator does not invent a format; it owns the layer nobody else builds:
**one canonical, user-owned skills root, projected into every runtime the app
launches** — instead of the ecosystem's copy-into-N-vendor-dirs model, which
duplicates and drifts.

Two planes exist and stay distinct:

- **Vendor-native plane (read-only, existing).** Skills the CLIs discover
  themselves (`~/.claude/skills`, `~/.gemini/...`, Codex `skills/list`, ACP
  `availableCommands`). Integrator scans/lists these, badges provenance, and
  never writes into vendor stores (local-first §3).
- **Integrator plane (canonical, new).** Skills and plugins under the
  user-visible Documents root, registered in app-data, and projected into each
  runtime at launch with per-transport fidelity.

## 2. Storage layout and ownership

The user-visible roots are **siblings of `Projects`** under the existing
Documents convention: `Documents/AI Integrator/{Projects, Skills, Plugins}`.
One folder is the product's home; a user browsing it sees everything they
own.

| Location | Owner | Contents |
| --- | --- | --- |
| `Documents/AI Integrator/Skills/<name>/SKILL.md` | user (hand-editable) | standalone skills |
| `Documents/AI Integrator/Plugins/<plugin>/` | user | plugin bundles (`plugin.json`, `skills/`, `mcp.json`, `hooks/`); store installs land here |
| app-data `skills/registry.sqlite` (or settings keys, §6) | Integrator | enablement, install lockfile (source, pinned tree SHA, reviewed manifest hash, install time) |
| app-data `skills-projection/<provider>/<scope>/` | Integrator | regenerable per-runtime overlays (same pattern as `antigravity-control/`) |
| repo `.aiintegrator/knowledge/skills/` (optional, tracked) | project | project-scoped skills shared via git |

Rules:

- Documents paths resolve via `app.path().document_dir()` (as `project_create`
  does), never a hardcoded `~/Documents`. Path identity goes through the
  `PathIdentity` seam; canonicalization via `dunce`.
- Content (Documents) is the user's; state (app-data) is Integrator's. Deleting
  the app must leave the user's skills intact and portable.
- **First-party plugins ship bundled inside the app** (read-only `Bundled`
  source), not auto-materialized into Documents. Rationale: app updates can
  update bundled skills atomically; copies in Documents would drift and
  couldn't be safely overwritten. The Settings UI shows both planes
  uniformly, and any bundled skill has a one-click **"Copy to my Skills"**
  action that materializes an editable copy into the Documents root (the
  copy shadows the bundled original by name+hash dedup once edited).
  **Store installs, by contrast, always land in `Documents/AI Integrator/Plugins/`**
  — they are user-acquired content, not app payload.
- **Project-scoped skills live in a tracked path under the repository root**
  (`.aiintegrator/knowledge/skills/`) so linked worktrees share them via git,
  resolving the per-worktree scan asymmetry (today `.claude/skills` in the main
  checkout is invisible from a linked worktree). Discovery scans the task's
  worktree; the tracked path travels with checkouts by construction.
- Vendor stores and credential files remain forbidden write targets.

## 3. Canonical types (integrator-core)

Add to `crates/integrator-core/src/domain.rs`, provider-neutral:

- `SkillSpec { id: SkillId, name, description, scope, source: SkillSource,
  path, content_hash, version: Option<String>, invocation, kind }`
- `SkillSource` = `Bundled | IntegratorUser | IntegratorProject |
  Plugin { plugin, version } | VendorNative { provider, root } |
  ProtocolListed { provider }`
- `PluginManifest { name, description, version, source_repo, tree_sha,
  manifest_hash, components: { skills, mcp_servers, hooks } }`
- `McpServerSpec`, `HookSpec` — unify the three existing MCP encoders
  (`write_mcp_config` / `codex_mcp_config` / `acp_mcp_server_entry`) and the
  antigravity hook overlay behind these.

**Identity is `(name, content_hash)`**, never the ephemeral action-handle id
(handles re-mint on every refresh) and never a filesystem path. Enablement,
transcripts, and dedup all key on this identity.

## 4. Discovery: unify, don't replace

`native_actions.rs` stays the discovery engine and gains one source class:
the Integrator plane (Documents roots + tracked project root + bundled
first-party set). Existing bounds remain load-bearing (512 actions, 64 KiB
metadata, symlink rejection, BFS caps) with one change: **truncation is
surfaced, not silent** — discovery returns a `truncated: bool` the UI must
render ("some skills were not loaded"), per QOL 113 (never fabricate
completeness).

Collision handling (fixes the current first-match-wins bug in
`Composer.tsx` slash resolution):

- Same name + same content hash across planes → collapse to one entry,
  provenance badge lists all locations, projection skips runtimes that already
  have it natively.
- Same name + different hash → both survive, slash menu **must disambiguate**
  (`name (source)`); a bare `/name` send with two live candidates is rejected
  with a picker, never silently resolved. Warn in Settings when two *active*
  skills claim the same trigger (QOL 114).
- The hardcoded `BUNDLED` list in `discover_claude` migrates into the
  first-party catalog (§9) as data, not code.

No filesystem watcher exists and none is required for MVP. Reload boundaries
are explicit (QOL 112/115): discovery re-runs on slash-menu open, settings
open, and task start. **Activation boundary is "next turn"** — a skill edited
or toggled mid-turn takes effect on the next send, and the projection overlay
for an in-flight turn is immutable (overlays are written per-launch, so this
holds by construction). The UI labels this assumption. A debounced watcher on
the two Documents roots is a Beta nicety, not MVP.

## 5. Projection: per-transport adapters and fidelity tiers

One trait, implemented per transport family, invoked at launch/turn assembly:

```rust
trait CapabilityProjector {
    fn project(&self, enabled: &[SkillSpec], plan: &mut LaunchPlan) -> Result<Projection>;
}
```

`Projection` records what was actually delivered and how (native | overlay |
prompt-index | skipped+reason) — this feeds the QOL 111 precedence UI and the
transcript record.

| Runtime | Mechanism | Fidelity |
| --- | --- | --- |
| Claude (structured CLI) | materialize enabled skills as a plugin bundle in the projection overlay; pass `--plugin-dir <overlay>` (repeatable, works in `--print`; metadata auto-loads into the system prompt). `--settings <ephemeral>` reserved for enable/disable maps. | **A (native)** |
| Codex (app-server) | **shipped: prompt-index** — bounded index rides each plain turn; explicit `/name` injects the bounded skill body (typed `$name` selections stay reserved for Codex's own skills). Upgrade path: ephemeral `config` skill dirs at `thread/start` once the schema spike lands. | **B (index) / A- (explicit invoke)** |
| Antigravity | **shipped**: per-turn overlay bundles granted via `--add-dir` (sandbox-readable) + prompt-index pointing at the overlay copies; explicit `/name` injects the bounded body. | **B+** |
| ACP (Cursor, Grok, future) | **shipped: prompt-index** on each plain turn (name + description + absolute path per skill) with the instruction to read the SKILL.md on match; explicit `/name` invocation injects the resolved body into that turn's wire prompt. The persisted transcript keeps the typed `/name` and records `native_skill`. | **B (index) / A- (explicit invoke)** |

Degradation is honest: when projection is unavailable, the setting UI states
"the underlying CLI may still discover its own skills" (QOL 114 fallback
language). `ProviderCapabilities.skills` gating in `providers.rs` remains the
authority; the fidelity tier maps onto the integration-catalog A–D levels.

Invocation asymmetry is preserved, not papered over: Codex gets the typed
`CodexSkillSelection` + `$name` rewrite with path re-validation at send;
structured CLI passes `/name` through; ACP re-validates against
`availableCommands`. The double staleness re-check at send time stays.

## 6. Activation model and persistence

- **Toggles exist at two granularities: per-plugin and per-skill.** Disabling
  a plugin disables all its components (skills, MCP servers, hooks) in one
  action; individual skills inside an enabled plugin can still be toggled
  off. Every skill and plugin card in Settings has an on/off switch — this
  is the primary control surface, not an advanced option.
- Scopes: personal / project / task (QOL 114). Task-scope disablement is a
  registry row, never a file edit, and survives restart.
- Storage: the settings table with dotted keys. The key validator forbids `:`
  and caps 120 chars, and namespaced ids (`plugin:skill`) exceed both — so
  **enablement is stored as one JSON map per scope**
  (`skills.enabled.personal`, `skills.enabled.project.<project-hash>`), keyed
  inside the value by skill identity, not as one settings key per skill.
  These ride the existing settings export/import path.
- Every enabled skill costs context in every projected runtime; catalog
  installs default to **disabled**. Bundled first-party skills also default
  disabled except `skill-creator`.
- **Delegation inheritance:** child tasks inherit the parent's enabled set
  filtered by the child provider's fidelity tier, threaded through
  `DelegationChildDriver` (new field). MVP may ship with children inheriting
  nothing (status quo) but the doc-level decision is inherit-by-default at
  Beta, and the delegation preface must state which skills the child has.

## 7. Store: a static, signed catalog — no backend

Consistent with local-first §5 (no hosted services; sanctioned network =
signed static metadata):

- The store is a **git repo owned by us** containing `catalog.json`: entries
  of `{ name, description, category, source_repo, tree_sha, manifest_hash,
  docs_url, license, compatible_runtimes }`. Fetching it is the same shape as
  updater metadata: static, signed (minisign/ed25519 alongside the JSON),
  verified before parse.
- The renderer cannot fetch (CSP `connect-src` is IPC-only); a narrow Tauri
  command `skills_catalog_fetch` does the HTTPS GET in the host. This is
  **net-new native network code** and must: appear in the Settings/Diagnostics
  outbound-network inventory, be user-triggered (no background polling in v1),
  and fail closed to the last verified cached catalog.
- Install = download the pinned `tree_sha` archive (via `gh`/git for GitHub
  sources, reusing the `github.rs` gh-CLI posture where possible), verify the
  hash, then the **QOL 116 review screen**: full bundle preview (files,
  skills, MCP servers, hooks, requested network/paths), record the reviewed
  manifest hash in the lockfile. No one-click install from a name card.
- Updates are explicit and re-reviewed when authority expands (QOL 117); a
  changed hash means re-review, period (QOL 118 hash-bound trust).
- **Doc packs.** Catalog entries may declare a `doc_pack`: a list of
  first-party documentation URLs (llms.txt indexes and doc pages) that the
  installer downloads into the skill directory as cached reference files,
  with source URL + retrieval date recorded in an `ATTRIBUTION.md`. Skills
  are authored to grep the cached file when present and fetch the URL when
  not, so the pack is an offline/latency optimization, never a correctness
  dependency. Verified first-party sources as of 2026-07:
  Anthropic `platform.claude.com/llms.txt` (204 KB), OpenAI
  `developers.openai.com/llms.txt` (101 KB), xAI `docs.x.ai/llms.txt`
  (1.28 MB — section before caching), Vercel `vercel.com/llms.txt` +
  `ai-sdk.dev/llms.txt`, OpenRouter `openrouter.ai/docs/llms.txt`. Google
  Gemini publishes no llms.txt — link-only. Doc-pack refresh is manual
  (a "Refresh docs" button per skill), never background.
- **Official third-party skills are catalog entries, not forks.** Where a
  vendor ships their own skill pack we list it pinned rather than authoring
  a duplicate: Anthropic's `claude-api` skill (anthropics/skills,
  Apache-2.0) and Vercel's `agent-skills` pack (vercel-labs/agent-skills,
  MIT) are the first two. Redistribution-unfriendly sources (Anthropic's
  doc-site content) are linked, never vendored.
- Federating public registries (skills.sh, OpenAgentSkill API) is **Later**,
  matching the matrix's "general marketplace routing = Later". v1 store =
  our curated catalog only, which can *list* top community skills we've
  reviewed and pinned.

## 8. Security model

Threat context: published research found ~26% of scanned public skills carry
prompt-injection patterns; confirmed-malicious skills overwhelmingly pair
injection with script execution. Mitigations, all release-gating (matrix:
security review required for any new plugin/hook authority; C0/C1 cannot be
waived):

1. **Curation + pinning.** Catalog entries are reviewed by us and pinned by
   tree SHA. Upstream changes never flow silently.
2. **Hash-bound trust.** Enablement and hook trust bind to content/manifest
   hashes; any change invalidates trust and re-prompts review (QOL 117/118).
3. **Static scanning** of catalog candidates with at least one public scanner
   (Cisco Skill-Scanner / NVIDIA SkillSpector / Snyk Agent Scan) as a
   curation gate — best-effort, stated as such, never marketed as a guarantee.
4. **Discovery invariants preserved:** symlink rejection, 64 KiB metadata cap,
   charset-bounded names, body-never-reaches-renderer. The installer writes
   only under Documents roots and app-data overlays; never follows symlinks
   out of a skills root; never writes into vendor stores or the user repo
   (except the tracked project path on explicit user action).
5. **Provenance UI:** every skill card shows source, scope, version/commit,
   hash, invoked-vs-auto; filesystem skills with incomplete metadata are
   labeled `Unverified local skill` (QOL 113). The transcript records the
   identity `(name, content_hash, source)` that actually ran — extend
   `native_skill` on `ItemProjection` from a bare name to this tuple.
6. **Skills are instructions, not authority.** A skill never grants tool,
   path, or network authority by itself; MCP servers and hooks inside plugin
   bundles go through their own QOL 119/120 review. `allowed-tools`
   frontmatter is advisory cross-runtime and is displayed, not trusted.

## 9. First-party catalog ("ships with the app")

All first-party plugins live in-repo under `first-party/plugins/` (bundled
into the app as read-only `Bundled` source; also published to the public
catalog repo). Authored runtime-neutral: no Claude-specific tool names in
bodies; scripts are plain Python/bash with stdlib + `requests`-free `urllib`
where possible; every skill states its own API-key needs and never asks
Integrator to store credentials (settings validator forbids it — keys go in
the user's environment).

| Plugin | Skills | Notes |
| --- | --- | --- |
| `integrator-authoring` | `skill-creator` (enabled by default), `plugin-packager` | Interviews, writes into `Documents/AI Integrator/Skills/`, validates frontmatter against the spec. The one skill on by default. |
| `gov-data` | `fred`, `bls`, `census`, `eia`, `sec-edgar` | Flagship, genuinely differentiated. Free/public APIs; FRED+EIA+Census need free registered keys (env vars), BLS anonymous ≤ some daily cap — bodies state limits honestly. |
| `market-data` | `market-data` | Stooq CSV (keyless) primary, Alpha Vantage free tier optional. **Not yfinance** — unsupported scraper, ToS-fragile; the body says why and offers it only as explicit-user-choice last resort. |
| `ai-provider-docs` | `openai-docs`, `gemini-docs`, `xai-docs`, `ai-gateway-docs`, `openrouter-docs` | Each anchored to the provider's verified llms.txt (§7 doc packs) where one exists; Gemini is link-only. Claude API docs are covered by cataloging Anthropic's official `claude-api` skill (Apache-2.0) rather than authoring a duplicate — also sidesteps the spec rule that skill names may not contain "claude"/"anthropic". |
| `vercel` | `vercel-docs` | Deploy/config/edge patterns, llms.txt endpoints, CLI cheatsheet. |
| `firebase` | `firebase-docs` | Auth/Firestore/Functions/Hosting patterns + emulator workflows. |
| `cloudflare` | `cloudflare-docs` | Workers/Pages/R2/D1/KV patterns, wrangler cheatsheet. |
| `stripe` | `stripe-docs` | Payment-intent flows, webhook verification, test-mode patterns. |
| `supabase` | `supabase-docs` | Postgres/RLS/auth/realtime patterns. |
| `tauri` | `tauri-docs` | Dogfood: v2 capabilities/permissions, IPC, updater, signing. |
| `release-craft` | `changelog-writer`, `release-notes` | From git history to conventional changelog/notes. |

Docs-reference skills follow one template: frontmatter → "when to use" →
canonical docs links (llms.txt where the vendor publishes one) → distilled
cheatsheet (API shapes, auth, footguns) → "fetch the linked page before
answering version-specific questions". Anthropic's example skills are
Apache-2.0 (reusable); their doc-site content is not redistributable — we
link, we don't vendor.

## 10. Renderer surface

- Settings gains the contract-mandated **Skills** category (`SettingsSection`
  union + nav): installed list with provenance cards, **per-plugin and
  per-skill on/off switches** at each scope, collision warnings, store
  browser (catalog), "Create skill" (launches a task with `skill-creator`
  invoked), "Copy to my Skills" on bundled entries, "Refresh docs" on
  doc-pack skills, truncation banner, and the QOL 111 precedence stack view
  ("why is this skill active here?").
- Composer slash menu: unified list across planes with source badges and
  collision disambiguation; existing `NativeActionReference` shape extended
  with `sourceBadge` and `identity`, resolved by identity not array order.
- Renderer never receives skill bodies or absolute paths (existing invariant);
  install/enable/fetch are narrow typed commands with explicit capabilities.

## 11. Delivery phasing

**MVP (matrix 109–115):**
1. Canonical types + Documents roots + bundled first-party discovery
   (extend `native_actions.rs`; collision fix in backend + Composer).
2. Claude projection via `--plugin-dir` overlay; Codex ephemeral-config spike
   → native or fallback; ACP prompt-index; Antigravity overlay spike.
3. Settings Skills category: enablement (personal/project/task), provenance
   cards, activation-boundary labeling. Enablement persistence (§6).
4. `skill-creator` + `gov-data` + 2–3 docs plugins shipped bundled.

**Beta (matrix 116–120):** plugin bundles with MCP/hooks components + QOL
116–118 review flows; catalog fetch + store UI; delegation inheritance;
FS watcher; remaining first-party plugins.

**Later:** public registry federation, community submissions, skill signing.

**Explicit spikes before build:** (a) Codex ephemeral skill-config schema,
(b) Antigravity `--add-dir` skill scanning, (c) `--plugin-dir` behavior under
`--print` with plugin-shaped overlay across pinned Claude versions.

## 12. Test and fixture obligations (AGENTS.md)

Every runtime-touching piece needs happy / degraded / restart-reconnect /
cancellation-race / adversarial fixtures. Minimum adversarial set: symlinked
skill dir escaping the root; SKILL.md > 64 KiB; name with path traversal;
two same-named different-hash skills (must disambiguate, never first-match);
skill deleted between menu-open and send (stale handling exists — keep the
loud failure); catalog JSON with bad signature (must fail closed to cache);
plugin update with changed manifest hash (must force re-review); mid-turn
SKILL.md edit (turn must complete on the old overlay).

## 13. Decision log

- Adopt agentskills.io SKILL.md verbatim; plugin bundle layout mirrors Claude
  Code's, vendor-neutralized. No Integrator-proprietary format.
- Never write vendor stores; overlays + Documents only. "Promote to
  Integrator" copies vendor-native skills into the canonical root
  (non-destructive; hash-dedup hides the shadowed copy).
- Store is a static signed catalog, not a service. No accounts, no billing
  category (design-system contract L30).
- yfinance rejected as a first-party dependency (unsupported scraper).
- Identity = `(name, content_hash)`; handles stay ephemeral; settings store
  JSON maps, not per-skill keys.
