---
name: tauri-docs
description: Build and debug Tauri 2 desktop apps — Rust IPC commands, the capabilities/permissions model, window management, bundling, updater, and macOS/Windows code signing. Use when a project is a Tauri app.
---

# Tauri 2

## Canonical docs (fetch for version-specific answers)

- Docs root: https://tauri.app/
- Capabilities/permissions: https://tauri.app/security/capabilities/
- IPC/commands: https://tauri.app/develop/calling-rust/
- Updater plugin: https://tauri.app/plugin/updater/
- Distribution/signing: https://tauri.app/distribute/

## Footguns worth knowing

- **Tauri 2's security model is capabilities**: every command/plugin
  permission must be granted in a capability file
  (`src-tauri/capabilities/*.json`) scoped to specific windows. "Command not
  allowed" errors are missing capability entries, not code bugs.
- Commands taking `State<'_, T>` must be async or the state Mutex blocks the
  IPC thread; long work belongs in `tauri::async_runtime::spawn` with events
  back to the frontend, not in the command body.
- IPC serializes via serde — large binary payloads should use the custom
  protocol/`tauri::ipc::Response`, not JSON arrays of bytes.
- CSP in `tauri.conf.json` governs the webview; remote fetches from the
  renderer need `connect-src` entries or must be proxied through a Rust
  command (prefer the latter for authority control).
- Path handling: use `app.path()` resolvers, never hardcoded home paths; on
  Windows canonicalize via `dunce` to avoid `\\?\` prefixes.
- Updater requires signed update artifacts (`TAURI_SIGNING_PRIVATE_KEY`) and
  the pubkey embedded in config; macOS distribution additionally needs
  Developer ID signing + notarization or Gatekeeper blocks launch.
- `tauri dev` and release bundles differ in asset origin (`localhost` vs
  `tauri://`) — cookie/CORS-dependent code that works in dev can break in
  release.
