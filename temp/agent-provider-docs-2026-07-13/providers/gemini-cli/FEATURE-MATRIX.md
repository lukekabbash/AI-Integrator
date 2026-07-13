# Gemini CLI capability matrix

| Integrator dimension | Assessment |
|---|---|
| Transport | acp; launch `gemini --acp`; verify executable/version before resume. |
| Auth | Vendor-owned; Use Gemini CLI's official OAuth/API-key/application-credential flow. Integrator must not reuse OAuth tokens or inspect ~/.gemini credentials; it may pass only documented auth method choices and sanitized status. The CLI's own settings and trusted-folder rules remain authoritative. |
| Sessions | documented or vendor-supplied; reconcile after restart |
| Streaming | protocol/structured events after capability negotiation |
| Permissions | provider requests mapped to local policy and user decisions |
| Files/terminal | Vendor tools remain child-process authority; exact cwd and worktree required. |
| Models/effort | Discover from installed runtime; do not hard-code entitlements. |
| Usage | Vendor exact/local observed/estimated/unavailable per field; never infer subscription balance. |
| Updates | Vendor-owned update command or official installer; detect and guide only. |
| Windows | Must pass provider-specific launch, quoting, process-tree, and stderr fixtures before certification. |
