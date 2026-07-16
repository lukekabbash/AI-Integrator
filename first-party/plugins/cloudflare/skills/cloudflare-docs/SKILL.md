---
name: cloudflare-docs
description: Build on the Cloudflare developer platform — Workers, Pages, R2 storage, D1 database, KV, Durable Objects, queues, and wrangler configuration. Use when a project targets Cloudflare or uses wrangler.
---

# Cloudflare Developer Platform

## Canonical docs (fetch for version-specific answers)

- Docs index for agents: https://developers.cloudflare.com/llms.txt
- Workers: https://developers.cloudflare.com/workers/
- Wrangler config: https://developers.cloudflare.com/workers/wrangler/configuration/
- D1: https://developers.cloudflare.com/d1/ · R2: https://developers.cloudflare.com/r2/
- Durable Objects: https://developers.cloudflare.com/durable-objects/

## CLI cheatsheet

`wrangler dev` (local, uses Miniflare) · `wrangler deploy` ·
`wrangler tail` (live logs) · `wrangler d1 execute <db> --command "..."` ·
`wrangler r2 object put` · `wrangler kv key put --binding=...` ·
`wrangler secret put <NAME>`.

## Footguns worth knowing

- Workers run on V8 isolates, not Node. No fs, no raw TCP (use `connect()`
  from `cloudflare:sockets`), and Node built-ins only via the
  `nodejs_compat` flag — check compatibility before porting Node code.
- Bindings (KV/R2/D1/DO/queues) are declared in `wrangler.toml`/`.jsonc` and
  injected on `env` — they don't exist as globals, and local `wrangler dev`
  uses local simulations unless `--remote`.
- CPU-time limits (not wall-clock) bound Workers; awaiting fetch is free,
  heavy compute is not. `waitUntil()` for after-response work.
- D1 is SQLite semantics with eventual read replication — no long
  transactions, batch with `db.batch()`.
- KV is eventually consistent (~60s propagation) — never use it for
  read-after-write flows; that's what DO or D1 are for.
- Secrets go in `wrangler secret put`, never in wrangler.toml `vars` (those
  are plaintext config).
