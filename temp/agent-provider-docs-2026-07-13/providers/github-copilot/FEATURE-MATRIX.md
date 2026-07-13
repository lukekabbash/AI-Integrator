# GitHub Copilot CLI capability matrix

| Integrator dimension | Assessment |
|---|---|
| Transport | acp; launch `copilot --acp`; verify executable/version before resume. |
| Auth | Vendor-owned; Use copilot login's OAuth device flow or documented token environment variables. Integrator reports sanitized auth status and never copies GitHub tokens into its own store. Host selection, enterprise policy, and scopes remain GitHub-owned. |
| Sessions | documented or vendor-supplied; reconcile after restart |
| Streaming | protocol/structured events after capability negotiation |
| Permissions | provider requests mapped to local policy and user decisions |
| Files/terminal | Vendor tools remain child-process authority; exact cwd and worktree required. |
| Models/effort | Discover from installed runtime; do not hard-code entitlements. |
| Usage | Vendor exact/local observed/estimated/unavailable per field; never infer subscription balance. |
| Updates | Vendor-owned update command or official installer; detect and guide only. |
| Windows | Must pass provider-specific launch, quoting, process-tree, and stderr fixtures before certification. |
