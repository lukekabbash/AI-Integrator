# Runtime E2E QA Log

Date: 2026-07-16
Checkout: `feature/v1-native-app`

## Scope

I read the v1 scope, architecture, local-first, design-system, and implementation-plan contracts, then launched the Tauri dev app and exercised the available UI through the local browser surface because the dev binary was not discoverable by the desktop accessibility bridge.

## UI flow exercised

- Opened the local AI Integrator surface on `http://localhost:1420`.
- Opened **Add a project**.
- Chose **Create new project**.
- Entered `runtime-e2e-lab`.
- The UI reported the project as ready and showed the empty task composer and Git setup state.
- Opened the Runtime selector and observed: Codex, Cursor, Claude Code, Antigravity, and disabled Grok Build (`not installed`).
- Selected Codex, submitted a hello-world build/test request, and observed `Queued for execution codex · GPT-5.4 · off` followed by a persistent `Streaming` state.
- Selected Cursor in the runtime selector; the selection changed, but no native Cursor run was started.

## Runtime/build evidence

| Surface | Result | Evidence |
| --- | --- | --- |
| Tauri dev launch | Pass with environment workaround | A stale same-checkout Vite process held port 1420; after stopping it, sandboxed binding still failed with `EPERM` on `::1:1420`, so the local dev launch required an approved escalated command. |
| Native app discoverability | Fail | The native process ran, but Computer Use could not resolve `AI Integrator`, `dev.aiintegrator.desktop`, or the debug binary path as an accessible app. |
| Tauri package build | Fail | `npm run build` stopped in `tsc -b`: missing `permission` fields in `src/components/RightRail.test.tsx` fixtures and unused `syncRemote` in `src/components/RightRail.tsx`. |
| Renderer tests | Fail | `npm test`: 550 passed, 4 failed. Failures: 3 in `src/App.runtime.test.tsx` and 1 in `src/App.test.tsx`. |
| Rust workspace tests | Pass | `cargo test --workspace`: all executed tests passed; 2 tests were ignored by design. |

## Runtime matrix

| Runtime | UI catalog state | End-to-end result |
| --- | --- | --- |
| Codex | Selectable; displayed as `codex · GPT-5.4` | Blocked at browser-preview streaming; native execution could not be proven because the packaged app did not build and the dev window was not attachable. |
| Cursor | Selectable | Selection path observed; no native execution proof. |
| Claude Code | Selectable | Catalog path observed only; no native execution proof. |
| Antigravity | Selectable | Catalog path observed only; no native execution proof. |
| Grok Build | Disabled, `not installed` | Correctly fail-closed in the selector. |

## Pitfalls and failures

1. Port handling: port 1420 was held by a dead/stale Vite process from this repository. The correct recovery was to inspect and stop that process, not to allocate another port.
2. Sandbox networking: even with the port free, the sandbox rejected the loopback bind with `EPERM`; the dev launch required explicit escalation.
3. Desktop automation: the Tauri debug binary did not appear in the Computer Use app inventory, so the real native window could not be operated through accessibility actions.
4. Browser fallback boundary: the browser surface is useful for UI-flow inspection, but its “project ready” state did not produce a verifiable host folder, and its Codex request remained in `Streaming`. It must not be counted as a native runtime success.
5. Build gate: the current TypeScript errors prevent creation of a normal macOS app bundle, which is the path needed to continue native desktop QA.
6. Test drift: four renderer tests fail independently of the Rust suite, including recovery/task loading and Git review expectations.

## Next unblock

Fix the two TypeScript build errors first, then rerun the renderer suite and package a macOS app bundle. After the bundle is discoverable, repeat the disposable-project flow against native Codex and Cursor, then exercise preview/degraded states for Claude Code, Antigravity, and the disabled Grok route.
