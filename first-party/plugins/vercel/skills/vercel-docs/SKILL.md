---
name: vercel-docs
description: Deploy and configure projects on Vercel — vercel.json, environment variables, edge/serverless functions, domains, monorepos, and the Vercel CLI. Use when working on a project that deploys to Vercel or debugging a Vercel build/runtime issue.
---

# Vercel

## Canonical docs (fetch before answering version-specific questions)

- Docs index for agents: https://vercel.com/docs/llms.txt
- vercel.json reference: https://vercel.com/docs/project-configuration
- Functions: https://vercel.com/docs/functions
- Environment variables: https://vercel.com/docs/environment-variables
- CLI: https://vercel.com/docs/cli

## CLI cheatsheet

`vercel` (deploy preview) · `vercel --prod` · `vercel dev` (local) ·
`vercel env pull .env.local` · `vercel logs <url>` · `vercel link` ·
`vercel inspect <url>`. Auth via `vercel login`; CI uses `VERCEL_TOKEN`.

## Footguns worth knowing

- Env vars are snapshotted at build time for the frontend; changing one
  requires a redeploy. `NEXT_PUBLIC_`/framework-prefixed vars are inlined —
  never put secrets in them.
- `vercel.json` `rewrites` vs `redirects` vs framework-native routing:
  prefer framework routing; vercel.json wins conflicts and is a common source
  of "why is my route 404ing".
- Serverless function size/duration limits differ by plan and runtime; check
  the functions doc rather than assuming. Edge runtime has no Node APIs
  (no fs, limited crypto).
- Monorepos: set the project Root Directory in dashboard/`vercel.json`, and
  remember `ignoreCommand` to skip unaffected deploys.
- Preview deployments get unique URLs — cookies/CORS/OAuth callbacks
  configured for the prod domain will fail on previews; use wildcard callback
  patterns or the branch URL.

When debugging a failed build, get the actual build log (`vercel logs` or
dashboard) before theorizing; most failures are env vars missing in the
target environment or Node version mismatches (`engines` field).
