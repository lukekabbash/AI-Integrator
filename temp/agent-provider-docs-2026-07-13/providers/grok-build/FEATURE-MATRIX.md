# Grok Build capability matrix

| Integrator dimension | Assessment |
|---|---|
| Transport | acp; launch `grok agent stdio`; verify executable/version before resume. |
| Auth | Vendor-owned; Use `grok login`, device login, logout, or XAI_API_KEY as documented by xAI. Integrator passes only the advertised ACP auth method (for example cached_token) and never transports the token itself. |
| Sessions | documented or vendor-supplied; reconcile after restart |
| Streaming | protocol/structured events after capability negotiation |
| Permissions | provider requests mapped to local policy and user decisions |
| Files/terminal | Vendor tools remain child-process authority; exact cwd and worktree required. |
| Models/effort | Discover from installed runtime; do not hard-code entitlements. |
| Usage | Vendor exact/local observed/estimated/unavailable per field; never infer subscription balance. |
| Updates | Vendor-owned update command or official installer; detect and guide only. |
| Windows | Must pass provider-specific launch, quoting, process-tree, and stderr fixtures before certification. |
