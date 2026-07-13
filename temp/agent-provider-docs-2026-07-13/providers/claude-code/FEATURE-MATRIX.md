# Claude Code capability matrix

| Integrator dimension | Assessment |
|---|---|
| Transport | structured_process; launch `claude --print PROMPT --output-format stream-json --verbose`; verify executable/version before resume. |
| Auth | Vendor-owned; Claude Code owns login, subscription/API authentication, and credential storage. The Integrator route is explicitly user-configured and does not expose a login UI or inspect ~/.claude credential files. Run only documented non-secret version/status probes and let the user perform setup in a vendor-owned terminal. |
| Sessions | documented or vendor-supplied; reconcile after restart |
| Streaming | protocol/structured events after capability negotiation |
| Permissions | provider requests mapped to local policy and user decisions |
| Files/terminal | Vendor tools remain child-process authority; exact cwd and worktree required. |
| Models/effort | Discover from installed runtime; do not hard-code entitlements. |
| Usage | Vendor exact/local observed/estimated/unavailable per field; never infer subscription balance. |
| Updates | Vendor-owned update command or official installer; detect and guide only. |
| Windows | Must pass provider-specific launch, quoting, process-tree, and stderr fixtures before certification. |
