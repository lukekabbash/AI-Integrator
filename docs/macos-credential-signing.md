# macOS credential storage

The renderer never receives a saved credential after the explicit save
command. Provider and MCP launch paths receive only the exact secret required
for that connection.

## Development

Debug builds do not access macOS Keychain. Rebuilt development binaries have
changing code identities, which can otherwise turn normal skill, MCP, OAuth,
and voice-typing credential reads into repeated authorization dialogs.

Development credentials live in a dedicated native-only directory inside AI
Integrator's Application Support data. The directory is mode `0700`; each
credential is an atomic, mode `0600` file addressed by a hash of its service
and account identifiers. The values are never stored in the repository,
renderer state, SQLite, logs, exports, or tool payloads. Secrets enter provider
or MCP environments only for the connection that requires them.

Development never reads or migrates legacy Keychain items.

## Production

Production keeps credentials in macOS Keychain. Production artifacts must use
an Apple-issued `Developer ID Application` identity for direct distribution or
the appropriate Apple distribution identity for the App Store. Tauri accepts
the identity through `APPLE_SIGNING_IDENTITY` or its certificate import
environment variables.

Use:

```sh
npm run build:release
```

The release command refuses to produce a distributable macOS artifact when no
production signing identity is available.
