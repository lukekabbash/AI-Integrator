# Codex capability matrix

| Integrator dimension | Assessment |
|---|---|
| Transport | codex_app_server; launch `codex app-server --stdio`; verify executable/version before resume. |
| Auth | Vendor-owned; Use app-server account endpoints or the vendor CLI's documented login flow. Integrator passes only auth method identifiers and receives sanitized status; it never reads ~/.codex/auth.json or carries API-key values through the renderer. |
| Sessions | not guaranteed; treat as one bounded run |
| Streaming | protocol/structured events after capability negotiation |
| Permissions | provider requests mapped to local policy and user decisions |
| Files/terminal | Vendor tools remain child-process authority; exact cwd and worktree required. |
| Models/effort | Discover from installed runtime; do not hard-code entitlements. |
| Usage | Vendor exact/local observed/estimated/unavailable per field; never infer subscription balance. |
| Updates | Vendor-owned update command or official installer; detect and guide only. |
| Windows | Must pass provider-specific launch, quoting, process-tree, and stderr fixtures before certification. |
