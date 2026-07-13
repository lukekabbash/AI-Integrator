# Custom ACP capability matrix

| Integrator dimension | Current app truth |
|---|---|
| Transport | User-configured ACP over local stdio. |
| Auth | Unknown/provider-owned; no Integrator credential proxy. |
| Sessions | ACP session lifecycle only when advertised. |
| Streaming | ACP `session/update` events after negotiation. |
| Permissions | ACP requests constrained by the local policy ceiling. |
| Tools | Provider-advertised; MCP/skills/hooks are opt-in. |
| Models/effort | Advertised config options only. |
| Usage | Unavailable unless the provider reports a documented field. |
| Updates | User/vendor-owned; Integrator does not install automatically. |
| Platforms | Conformance required for each configured executable/platform. |
