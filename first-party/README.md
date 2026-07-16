# First-party plugins

Plugins AI Integrator ships bundled (read-only, `Bundled` source, disabled by
default except `skill-creator`) and publishes to the public catalog. See
`docs/universal-capabilities.md` §9 for authoring rules; the short version:

- Skills follow the open agentskills.io `SKILL.md` format, runtime-neutral —
  no runtime-specific tool names, config paths, or slash conventions in
  bodies.
- API keys are user-set environment variables named in the skill body; skills
  never ask the app to store credentials.
- Docs-reference skills link canonical documentation (llms.txt where
  available) and instruct fetching it for version-specific answers. Cached
  copies arrive only via user-triggered doc-pack downloads with recorded
  attribution (see `docs/universal-capabilities.md` §7); we never bundle
  third-party doc content into the app itself.

Layout: `plugins/<plugin>/.claude-plugin/plugin.json` +
`plugins/<plugin>/skills/<skill>/SKILL.md`.
