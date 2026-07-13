# OpenCode capability matrix

| Integrator dimension | Assessment |
|---|---|
| Transport | acp; launch `opencode acp --cwd WORKSPACE`; verify executable/version before resume. |
| Auth | Vendor-owned; OpenCode manages provider credentials via `opencode auth login/list/logout` and documented environment/config inputs. Integrator must not read auth.json or copy provider keys; use only vendor command status and capability probes. |
| Sessions | documented or vendor-supplied; reconcile after restart |
| Streaming | protocol/structured events after capability negotiation |
| Permissions | provider requests mapped to local policy and user decisions |
| Files/terminal | Vendor tools remain child-process authority; exact cwd and worktree required. |
| Models/effort | Discover from installed runtime; do not hard-code entitlements. |
| Usage | Vendor exact/local observed/estimated/unavailable per field; never infer subscription balance. |
| Updates | Vendor-owned update command or official installer; detect and guide only. |
| Windows | Must pass provider-specific launch, quoting, process-tree, and stderr fixtures before certification. |
