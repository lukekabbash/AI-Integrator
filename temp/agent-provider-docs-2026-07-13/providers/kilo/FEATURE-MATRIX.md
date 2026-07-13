# Kilo capability matrix

| Integrator dimension | Assessment |
|---|---|
| Transport | acp; launch `kilo acp`; verify executable/version before resume. |
| Auth | Vendor-owned; Kilo uses `/connect`, `kilo auth`, gateway login, and provider-specific credentials. Integrator should only expose sanitized auth state and let Kilo own its credential/config stores; remote mode is outside the local-only v1 route. |
| Sessions | documented or vendor-supplied; reconcile after restart |
| Streaming | protocol/structured events after capability negotiation |
| Permissions | provider requests mapped to local policy and user decisions |
| Files/terminal | Vendor tools remain child-process authority; exact cwd and worktree required. |
| Models/effort | Discover from installed runtime; do not hard-code entitlements. |
| Usage | Vendor exact/local observed/estimated/unavailable per field; never infer subscription balance. |
| Updates | Vendor-owned update command or official installer; detect and guide only. |
| Windows | Must pass provider-specific launch, quoting, process-tree, and stderr fixtures before certification. |
