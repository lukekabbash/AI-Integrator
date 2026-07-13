# Qwen Code capability matrix

| Integrator dimension | Assessment |
|---|---|
| Transport | acp; launch `qwen --acp --experimental-skills`; verify executable/version before resume. |
| Auth | Vendor-owned; Use Qwen Code's documented login/token-plan/API-key routes. Integrator must not inspect Qwen credential files or assume an OAuth/free-tier entitlement; auth and provider selection remain vendor-owned and version-sensitive. |
| Sessions | not guaranteed; treat as one bounded run |
| Streaming | protocol/structured events after capability negotiation |
| Permissions | provider requests mapped to local policy and user decisions |
| Files/terminal | Vendor tools remain child-process authority; exact cwd and worktree required. |
| Models/effort | Discover from installed runtime; do not hard-code entitlements. |
| Usage | Vendor exact/local observed/estimated/unavailable per field; never infer subscription balance. |
| Updates | Vendor-owned update command or official installer; detect and guide only. |
| Windows | Must pass provider-specific launch, quoting, process-tree, and stderr fixtures before certification. |
