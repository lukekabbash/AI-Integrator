# Goose capability matrix

| Integrator dimension | Assessment |
|---|---|
| Transport | acp; launch `goose acp`; verify executable/version before resume. |
| Auth | Vendor-owned; Goose owns provider and extension configuration, including API keys or subscription-backed ACP providers. Integrator should use the documented CLI setup and sanitized config/status surfaces, never read secrets or rewrite provider config. |
| Sessions | not guaranteed; treat as one bounded run |
| Streaming | protocol/structured events after capability negotiation |
| Permissions | provider requests mapped to local policy and user decisions |
| Files/terminal | Vendor tools remain child-process authority; exact cwd and worktree required. |
| Models/effort | Discover from installed runtime; do not hard-code entitlements. |
| Usage | Vendor exact/local observed/estimated/unavailable per field; never infer subscription balance. |
| Updates | Vendor-owned update command or official installer; detect and guide only. |
| Windows | Must pass provider-specific launch, quoting, process-tree, and stderr fixtures before certification. |
