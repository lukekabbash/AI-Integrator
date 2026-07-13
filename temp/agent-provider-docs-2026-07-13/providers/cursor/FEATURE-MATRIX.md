# Cursor Agent capability matrix

| Integrator dimension | Assessment |
|---|---|
| Transport | acp; launch `cursor-agent acp`; verify executable/version before resume. |
| Auth | Vendor-owned; Use cursor-agent login/logout or the documented CURSOR_API_KEY path. Integrator can run the vendor command in a user-owned setup terminal, but never reads Cursor token stores or places API keys in argv/transcripts. |
| Sessions | documented or vendor-supplied; reconcile after restart |
| Streaming | protocol/structured events after capability negotiation |
| Permissions | provider requests mapped to local policy and user decisions |
| Files/terminal | Vendor tools remain child-process authority; exact cwd and worktree required. |
| Models/effort | Discover from installed runtime; do not hard-code entitlements. |
| Usage | Vendor exact/local observed/estimated/unavailable per field; never infer subscription balance. |
| Updates | Vendor-owned update command or official installer; detect and guide only. |
| Windows | Must pass provider-specific launch, quoting, process-tree, and stderr fixtures before certification. |
