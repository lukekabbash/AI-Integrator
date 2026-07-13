# Cline capability matrix

| Integrator dimension | Assessment |
|---|---|
| Transport | acp; launch `cline --acp`; verify executable/version before resume. |
| Auth | Vendor-owned; Use `cline auth` and provider-specific configuration in Cline's own data directory. Integrator may launch the vendor auth command in a user-owned setup terminal but never accepts or stores --key values in its own state. |
| Sessions | documented or vendor-supplied; reconcile after restart |
| Streaming | protocol/structured events after capability negotiation |
| Permissions | provider requests mapped to local policy and user decisions |
| Files/terminal | Vendor tools remain child-process authority; exact cwd and worktree required. |
| Models/effort | Discover from installed runtime; do not hard-code entitlements. |
| Usage | Vendor exact/local observed/estimated/unavailable per field; never infer subscription balance. |
| Updates | Vendor-owned update command or official installer; detect and guide only. |
| Windows | Must pass provider-specific launch, quoting, process-tree, and stderr fixtures before certification. |
