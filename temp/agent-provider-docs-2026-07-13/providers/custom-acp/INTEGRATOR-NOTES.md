# Custom ACP — Integrator dossier

Custom ACP is the app's user-configured runtime slot, represented natively as
`ProviderKind::CustomAcp` and in the renderer as `custom`. It is not discovered
as a named vendor, has no vendor-owned login/update path, and cannot make a
particular provider capability claim.

The user supplies a validated executable, argv, trusted cwd, protocol version,
and capability policy. The native supervisor launches it over ACP stdio, owns
stdin/stdout/stderr, completes `initialize`/`initialized`, creates a session,
maps bounded `session/update` events, handles permission requests, and reconciles
on cancellation, exit, or restart. The renderer receives only typed normalized
projections; it cannot supply arbitrary shell text or credential values.

Authentication, model selection, MCP servers, hooks, skills, plugins, subagents,
network access, and updates are all unknown until the configured agent advertises
them and the local policy accepts them. Do not inspect arbitrary config files or
token caches. Do not imply provider usage, billing, or quota semantics.

Required fixtures: malformed/oversized JSON-RPC, string/number request IDs,
unknown method/event, auth-method negotiation, permission allow/deny, session
resume, cancellation race, child process tree cleanup, untrusted cwd, secret
inheritance denial, and capability downgrade after reconnect.
