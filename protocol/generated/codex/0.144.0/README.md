# Codex app-server protocol snapshot

- Codex CLI: `0.144.0`
- Generated: 2026-07-10
- Scope: stable protocol only; experimental methods are not part of the default v1 adapter contract.

Generated locally from the installed official CLI:

```powershell
codex app-server generate-json-schema --out protocol/generated/codex/0.144.0/schema
codex app-server generate-ts --out protocol/generated/codex/0.144.0/typescript
```

These files are version-pinned fixtures and compile-time references. Runtime negotiation and capability checks remain mandatory; their presence does not authorize unsupported methods or imply compatibility with another CLI version.
