---
name: supabase-docs
description: Build and debug Supabase apps — Postgres schema and migrations, Row Level Security policies, auth, realtime subscriptions, storage, and edge functions. Use when a project uses Supabase.
---

# Supabase

## Canonical docs (fetch for version-specific answers)

- Docs index for agents: https://supabase.com/llms.txt
- Database & migrations: https://supabase.com/docs/guides/database
- Row Level Security: https://supabase.com/docs/guides/database/postgres/row-level-security
- Auth: https://supabase.com/docs/guides/auth
- Local dev/CLI: https://supabase.com/docs/guides/local-development

## CLI cheatsheet

`supabase start` (local stack via Docker) · `supabase db diff -f <name>`
(generate migration from local changes) · `supabase db push` ·
`supabase db reset` (replay migrations + seed) · `supabase gen types
typescript --local` · `supabase functions serve`.

## Footguns worth knowing

- **RLS is the security model.** The `anon` key is public by design; any
  table exposed via the API without RLS enabled is world-readable/writable.
  Enable RLS on every table and write policies — client-side filtering is
  not authorization.
- The `service_role` key bypasses RLS entirely: server-only, never in client
  bundles or NEXT_PUBLIC-style vars.
- Schema changes belong in migrations (`supabase/migrations/`), not the
  dashboard SQL editor — dashboard edits drift from the repo and break
  teammates' `db reset`.
- Policies run per-row as SQL; `auth.uid()` comparisons need indexes on the
  user-id column or large tables get slow. Wrap `auth.uid()` in `(select
  auth.uid())` for plan caching.
- Realtime requires replication enabled per table and respects RLS; silent
  empty subscriptions are usually a policy, not a bug.
- Connection limits: serverless runtimes must use the pooled connection
  string (transaction mode) — direct connections exhaust Postgres fast.
