# Kiro CLI capability matrix

| Integrator dimension | Assessment |
|---|---|
| Transport | acp; launch `kiro-cli acp`; verify executable/version before resume. |
| Auth | Vendor-owned; Kiro uses browser authentication and documented API-key headless flows. Integrator may open the official setup flow and report sanitized `whoami`/version state, but must not read Kiro token stores or add keys to its own environment. |
| Sessions | documented or vendor-supplied; reconcile after restart |
| Streaming | protocol/structured events after capability negotiation |
| Permissions | provider requests mapped to local policy and user decisions |
| Files/terminal | Vendor tools remain child-process authority; exact cwd and worktree required. |
| Models/effort | Discover from installed runtime; do not hard-code entitlements. |
| Usage | Vendor exact/local observed/estimated/unavailable per field; never infer subscription balance. |
| Updates | Vendor-owned update command or official installer; detect and guide only. |
| Windows | Must pass provider-specific launch, quoting, process-tree, and stderr fixtures before certification. |
