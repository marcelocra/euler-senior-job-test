# Migration Plan

## 1. Target stack

**Recommendation: Next.js + TypeScript for the app, hosted Supabase (Postgres, Auth, RLS, Storage, Edge Functions) to start.**

There's no universally "best" stack. The right choice depends on what the team already knows, how easy it is to learn and hire for, the quality of docs/community/AI tooling support, how mature and battle-tested the libraries are, what migration paths exist off the no-code platform, and the operational burden it puts on a small team. Judged against those constraints:

- **Keep React + TypeScript.** It's what the team chose for this exercise, so likely what they already know.
- **Move from Vite (SPA) to Next.js.** Nimbus will need privileged, server-side logic soon (anything touching a service-role key, future webhooks/billing) that must never run in the browser. Next.js gives us routing plus a built-in API/server boundary without standing up a separate backend service, and it's a mature, widely-adopted framework with a strong ecosystem, hiring pool, docs, and AI/tooling support. It can still ship as a mostly static/SPA-like app initially and grow into server features incrementally.
- **Keep Supabase, hosted.** It's managed Postgres plus Auth/RLS/Storage/Edge Functions, so there's no infra to stand up and we keep the RLS-based multi-tenancy already built. Just as importantly, the data underneath is standard Postgres, not a proprietary format. Unlike the no-code platform we're leaving, there's a real exit path later (self-host the same OSS stack, or move to another managed Postgres provider) if cost, compliance, or scale ever demand it.
- **Principle going forward:** privileged operations (secrets, cross-tenant admin actions, anything security-sensitive) live server-side in API routes/Edge Functions, never in the browser client.

Alternatives (a separate custom backend from day one, different BaaS, different frameworks) seem to have less fit right now.

## 2. Data migration: `tasks` table

Chosen as the specific slice because it's representative of the migration work generally, and lower-risk than migrating users/auth (see note below).

### Target schema

`public.tasks` already exists (`supabase/migrations/0001_init.sql`) with `workspace_id`, `title`, `status`, `assignee_id`, timestamps. For the migration we add one temporary column:

- `legacy_id text unique`: the no-code platform's original task ID, used for idempotent re-runs and auditing. Dropped once the migration is verified and closed out.

### Steps

1. **Extract** all tasks from the no-code platform's export/API, including archived/soft-deleted rows (decide explicitly whether to bring them over).
2. **Stage** the raw export untransformed into `staging.legacy_tasks`, giving a durable, re-queryable snapshot independent of the source system's availability.
3. **Map dependencies first**: workspaces and users must already be migrated, with `legacy_id -> id` mapping tables to resolve `workspace_id`/`assignee_id`.
4. **Transform and load** via an idempotent job that upserts into `public.tasks` on conflict `(legacy_id)`: map legacy status values explicitly (default + log anything unrecognized), resolve workspace/assignee through the mapping tables, and skip-and-log (not fail-the-batch) on unresolved references.
5. **Dry run** the job against a scratch schema/copy before touching real data.
6. **Validate**: row counts per workspace (source vs. migrated, with any intentional drops explicitly listed), a checksum per row (hash of title/status/assignee/timestamps) compared between staging and target, and a manual audit of a random sample plus every skipped/defaulted row.
7. **Cutover** (see downtime strategy below).
8. **Rollback**: keep the source platform and `staging.legacy_tasks` untouched and readable until sign-off; rollback means stopping writes to the new table and reverting to the old platform, or restoring from a pre-cutover Postgres snapshot if already cut over.
9. **Close out**: after a burn-in period in production, archive `staging.legacy_tasks` and drop `legacy_id`.

### Downtime / data-loss strategy

- **Pragmatic default:** a short scheduled read-only/maintenance window on the old platform for the duration of extract + load + validate. For a table this size, this is lower-risk and far less work than real-time sync, and is the right default unless downtime is a hard constraint.
- **If zero downtime is a hard requirement:** add dual-write (or CDC, if the old platform exposes a change stream) during the transition, then a final delta sync and a brief cutover to flip reads to Postgres. This adds real complexity, with conflict handling and drift monitoring, so it should only be built if genuinely required.
- The idempotent `legacy_id` upsert makes either approach safe to re-run to catch any last-second writes near the cutover boundary.

### Risks

- Bad status/field mapping causing silent corruption → mitigated by explicit mapping, checksums, and sample audits.
- Orphaned references from partially-migrated workspaces/users → mitigated by migrating dependencies first and skip-and-log on failure.
- Duplicate rows from re-running the job → mitigated by the `legacy_id`-keyed upsert.
- Drift during the migration window → mitigated by the read-only window, or a final delta sync in the dual-write case.
- No way back after cutover → mitigated by leaving the source and staging table intact through a burn-in period, plus a pre-cutover snapshot.

### Observability

- Log (or a `migration_runs` table) of rows read/inserted/updated/skipped/defaulted, with reasons, per run.
- A repeatable count/checksum comparison between `staging.legacy_tasks` and `public.tasks`, usable on demand post-cutover.
- A simple alert/check if live row counts diverge from the expected source count after cutover.

### Note on users/auth

Users/auth is intentionally not this slice. Passwords and sessions generally can't be carried over directly (different hashing, or no exportable hash at all), so it likely needs an invite/reset-password flow post-cutover. It's a separate, riskier piece of work that shouldn't be bundled with the tasks migration.
