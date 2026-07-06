# Migration Plan

## Executive summary

- Keep React + Vite + TypeScript for the app in this first migration phase.
- Use hosted Supabase (Postgres, Auth, RLS, Edge Functions) rather than standing up new infra.
- Keep privileged, server-side logic in Edge Functions, never in browser code.
- Migrate `tasks` as the concrete slice, via a staging table and idempotent `legacy_id` upserts.
- Protect against data loss with backups, dry runs, validation, a feature flag/cutover switch, and a rollback path.
- Treat users/auth as a separate, harder slice, out of scope here.

## 1. Target stack

**Recommendation for the first migration phase: keep React + Vite + TypeScript for the app, hosted Supabase (Postgres, Auth, RLS, Storage, Edge Functions), and push privileged operations into Supabase Edge Functions.**

There's no universally "best" stack. The right choice depends on what the team already knows, how easy it is to learn and hire for, the quality of docs/community/AI tooling support, how mature and battle-tested the libraries are, what migration paths exist off the no-code platform, and the operational burden it puts on a small team. Judged against those constraints:

- **Keep React + Vite + TypeScript.** It's what the team chose for this exercise, so likely what they already know, and it's a working app today. Staying here minimizes migration scope: no new framework, no new build system, no new deployment target to learn or operate.
- **Keep Supabase, hosted.** It's managed Postgres plus Auth/RLS/Storage/Edge Functions, so there's no infra to stand up and we keep the RLS-based multi-tenancy already built. Just as importantly, the data underneath is standard Postgres, not a proprietary format. Unlike the no-code platform we're leaving, there's a real exit path later (self-host the same OSS stack, or move to another managed Postgres provider) if cost, compliance, or scale ever demand it.
- **Use Supabase Edge Functions for privileged, server-side logic.** Nimbus will need privileged operations soon (anything touching a service-role key, future webhooks/billing) that must never run in the browser. Edge Functions already exist in this repo (`supabase/functions/`) and give us that server-side boundary today, without introducing a second runtime, a new server framework, or a new deployment path (e.g. Vercel/AWS) on top of what's already deployed. **Principle going forward:** privileged operations (secrets, cross-tenant admin actions, anything security-sensitive) live server-side in Edge Functions, never in the browser client.
- **Next.js as a later option, not now.** If the product grows into needing more integrated server-side rendering, file-based routing, a broader API surface, or generally a fuller full-stack app shell than Edge Functions comfortably provide, Next.js (or a similar framework) is a reasonable next step. That's a bigger migration (new framework, new build/deploy pipeline) best justified by concrete needs rather than taken upfront.

Alternatives (a separate custom backend from day one, different BaaS, different frameworks) seem to have less fit right now.

## 2. Data migration: `tasks` table

Chosen as the specific slice because it's representative of the migration work generally, and lower-risk than migrating users/auth (see note below).

### Target schema

`public.tasks` already exists (`supabase/migrations/0001_init.sql`) with `workspace_id`, `title`, `status`, `assignee_id`, timestamps. For the migration we add one temporary column:

- `legacy_id text unique`: the no-code platform's original task ID, used for idempotent re-runs and auditing. Dropped once the migration is verified and closed out.

### Prerequisite: workspace/user mappings

This slice depends on `legacy_id -> id` mapping tables for workspaces and users, used to resolve `workspace_id`/`assignee_id` on each task. This is a real dependency, not a hand-wave:

- **If workspaces/users are already migrated** with mapping tables in place, this slice can proceed directly.
- **If they are not migrated yet**, do a minimal mapping/import pass first: extract workspaces and users from the no-code platform, create the corresponding `public.workspaces` rows, provision each user as a Supabase Auth user (`auth.users`, e.g. via an invite flow) and link them to their workspace(s) via `memberships`, and build `legacy_id -> id` mapping tables (a dedicated migration-mapping table, since `auth.users` and `memberships` don't carry a `legacy_id` column themselves) from that import. This doesn't need to be the full users/auth migration (see note below on why auth is out of scope here) — just enough identity and workspace records for tasks to reference. Tasks migration should not start until these mappings exist and have been spot-checked.

### Steps

1. **Extract** all tasks from the no-code platform's export/API, including archived/soft-deleted rows (decide explicitly whether to bring them over).
2. **Stage** the raw export untransformed into `staging.legacy_tasks`, giving a durable, re-queryable snapshot independent of the source system's availability.
3. **Back up** before writing anything: keep a complete, immutable export/snapshot of the source tables (workspaces, users, tasks) as extracted, and take a pre-cutover Postgres snapshot of the target database. Together these guarantee manual fixes or a full rollback stay possible even after the migration job has run.
4. **Confirm dependencies**: workspace/user mapping tables exist and have been spot-checked (see prerequisite above).
5. **Transform and load** via an idempotent job that upserts into `public.tasks` on conflict `(legacy_id)`: map legacy status values explicitly (default + log anything unrecognized), resolve workspace/assignee through the mapping tables, and skip-and-log (not fail-the-batch) on unresolved references.
6. **Dry run** the job against a scratch schema/copy before touching real data.
7. **Validate**: row counts per workspace (source vs. migrated, with any intentional drops explicitly listed), a checksum per row (hash of title/status/assignee/timestamps) compared between staging and target, and a manual audit of a random sample plus every skipped/defaulted row.
8. **Cutover** (see downtime and cutover-control strategy below).
9. **Rollback**: keep the source platform and `staging.legacy_tasks` untouched and readable until sign-off; rollback means flipping the cutover flag back, stopping writes to the new table, and reverting to the old platform, or restoring from the pre-cutover Postgres snapshot if already cut over.
10. **Close out**: after a burn-in period in production, archive `staging.legacy_tasks` and drop `legacy_id`.

### Cutover control

Use a feature flag/config setting to control which system is the source of truth for reads and writes, rather than relying on a code deploy for the switch:

- Prefer a flag/setting on the old (no-code) platform if it supports one, so it can put itself into a known read-only or redirect state.
- Otherwise, use an app-level setting (e.g. a config row or env-backed flag read by the frontend/Edge Functions) that the app checks to decide whether tasks reads/writes go to the old platform or Postgres.
- Either way, the flag should flip atomically for all users of a workspace, so reads and writes always agree on which system is authoritative — no split-brain state where some requests hit the old platform and others hit Postgres mid-cutover.

### Downtime / data-loss strategy

- **Pragmatic default:** a short scheduled read-only/maintenance window on the old platform for the duration of extract + load + validate, with the cutover flag flipped at the end of the window. For a table this size, this is lower-risk and far less work than real-time sync, and is the right default unless downtime is a hard constraint.
- **If zero downtime is a hard requirement:** add dual-write (or CDC, if the old platform exposes a change stream) during the transition, then a final delta sync and a brief cutover to flip the flag and reads to Postgres. This adds real complexity, with conflict handling and drift monitoring, so it should only be built if genuinely required.
- The idempotent `legacy_id` upsert makes either approach safe to re-run to catch any last-second writes near the cutover boundary.

### Risks

- Bad status/field mapping causing silent corruption → mitigated by explicit mapping, checksums, and sample audits.
- Orphaned references from partially-migrated workspaces/users → mitigated by migrating/mapping dependencies first and skip-and-log on failure.
- Duplicate rows from re-running the job → mitigated by the `legacy_id`-keyed upsert.
- Drift during the migration window → mitigated by the read-only window, or a final delta sync in the dual-write case.
- Inconsistent reads/writes during cutover → mitigated by the atomic feature flag/config flip instead of a gradual code-based switch.
- No way back after cutover → mitigated by the pre-migration source export/snapshot and pre-cutover Postgres snapshot, plus leaving the source and staging table intact through a burn-in period.

### Observability

- Log (or a `migration_runs` table) of rows read/inserted/updated/skipped/defaulted, with reasons, per run.
- A repeatable count/checksum comparison between `staging.legacy_tasks` and `public.tasks`, usable on demand post-cutover.
- A simple alert/check if live row counts diverge from the expected source count after cutover.

### Note on users/auth

Users/auth is intentionally not this slice. Passwords and sessions generally can't be carried over directly (different hashing, or no exportable hash at all), so it likely needs an invite/reset-password flow post-cutover. It's a separate, riskier piece of work that shouldn't be bundled with the tasks migration.
