# Aider capability matrix

| Integrator dimension | Assessment |
|---|---|
| Transport | pty; launch `aider`; verify executable/version before resume. |
| Auth | Vendor-owned; Aider accepts provider API keys through command flags, environment variables, .env, or .aider.conf.yml. Integrator must not inject or persist those secrets; the safe route is a user-owned setup terminal and PTY secure-input transfer outside model context. |
| Sessions | not guaranteed; treat as one bounded run |
| Streaming | PTY text only; no typed event guarantee |
| Permissions | textual prompts only; no bidirectional typed approval |
| Files/terminal | Vendor tools remain child-process authority; exact cwd and worktree required. |
| Models/effort | Discover from installed runtime; do not hard-code entitlements. |
| Usage | Vendor exact/local observed/estimated/unavailable per field; never infer subscription balance. |
| Updates | Vendor-owned update command or official installer; detect and guide only. |
| Windows | Must pass provider-specific launch, quoting, process-tree, and stderr fixtures before certification. |
