# AI Integrator desktop asset and third-party notices

This file covers assets and frontend packages used by the native desktop application. The audited runtime asset allowlist is `apps/desktop/public/assets-manifest.json`.

## First-party AI Integrator mark

`apps/desktop/public/brand/ai-integrator-mark-light.png` is copied without modification from `H:/Code/integrator-2/public/images/logos/aiintegrator-ai-mark-transparent.png` at source commit `7836ad599a9deed05e240a9fbaff3158a5572993` (`Rebrand app to AI Integrator`). Its SHA-256 digest is `8B889F701BAAA5EC5087A2B494BF88A1F8D697364EFF773736DADA32C36129B8`.

The mark is treated as first-party AI Integrator branding. It is not a general-purpose open-source asset.

## Provider favicon marks

The runtime and model selectors include small, unmodified favicon files from the official provider domains listed in `apps/desktop/public/assets-manifest.json` for quick visual identification. They are trademarks of OpenAI/Codex, Cursor, Anthropic/Claude, Google/Gemini, and xAI/Grok; they are not AI Integrator branding. A release owner should complete the providers' trademark review before distributing a signed production build.

## Frontend packages

The desktop package includes open-source dependencies declared in `apps/desktop/package.json`. Their package distributions and upstream license files remain authoritative. Notable user-interface dependencies include:

- `lucide-react`, used for application action icons under the Lucide ISC license.
- `motion`, used for restrained, accessibility-aware transitions under the Motion MIT license.
- `React` and `React DOM`, used for the shared interface under the React MIT license.
- `react-markdown` and `remark-gfm`, used for safe transcript rendering under their respective MIT licenses.
- `Zustand` and `Zod`, available to the desktop application under their MIT licenses.
- `xterm.js`, available to the desktop application under its MIT license.

Before a signed release, the packaging pipeline must generate and review a complete dependency license inventory from the exact lockfile. This notice does not grant rights to third-party runtime or provider trademarks.
