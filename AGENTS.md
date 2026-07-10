# AI Integrator engineering contract

- Treat `docs/v1-scope.md`, `docs/architecture.md`, `docs/local-first-contract.md`, and `docs/design-system-contract.md` as normative.
- Preserve the accountless, local-first boundary. Do not add a required application backend, credential proxy, cloud sync, or telemetry pipeline.
- The renderer never receives arbitrary shell, filesystem, Git, or credential authority. Add narrow typed Tauri commands and capabilities.
- Keep vendor credentials in vendor/OS-owned stores. Never log or persist password, MFA, token, hardware-key, or no-echo terminal input.
- All writing runs use explicit repository/worktree identity. Commit, Push, Merge, Deploy, and Cleanup remain distinct actions.
- Shared state is broker-owned; child/run scratch is run-owned. Prefer references over copied transcript/context.
- Use semantic design tokens. Do not add literal product colors outside the theme definitions and tests.
- Git diffs use accessible red/green semantics plus signs, gutters, labels, and screen-reader text; never hue alone.
- Add fixtures for happy, degraded, restart/reconnect, cancellation-race, and adversarial states with each runtime/critical-system change.
- Run formatting, type checks, Rust tests, UI tests, and relevant conformance checks before committing.

