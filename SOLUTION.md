# Task 1 — Write-up

## 1a — Bugs

All three fixes are in `web/src/components/TaskList.tsx`.

**1. Stale search results.**

- _Root cause:_ every keystroke fired a new `tasks` query with no cancellation
  and no ordering guard. Responses don't always resolve in the order they
  were sent, so a slow response for an older term could land after a newer
  one and overwrite it.
- _Fix:_ each effect run creates its own `AbortController`, passed to
  Supabase via `.abortSignal()`. The cleanup aborts the previous request on
  every `search`/`activeWorkspaceId` change (and on unmount), and the
  `.then()` callback also bails out if `controller.signal.aborted`. Only the
  latest request can ever set `searchResults`.
- _Validated:_ `pnpm build`/`pnpm test` pass; traced the effect's
  abort/cleanup ordering by hand for out-of-order responses.
  _To confirm live:_ throttle the network, type a term, then change it before
  the response returns. Expect: the first request shows `(canceled)` in the
  Network tab, and the list only ever matches the last term typed.

**2. Sluggish after switching workspaces.**

- _Root cause:_ the auto-refresh effect called `setInterval(…, 5000)` on
  every workspace change with no cleanup, so old intervals were never
  cleared — they piled up, each firing its own fetch every 5s. Separately,
  `loadTasks` was memoized with `useCallback(fn, [])`, so it permanently
  captured whichever `activeWorkspaceId` existed on the first render; every
  call (interval, mutation, workspace switch) kept querying that original
  workspace instead of the current one.
- _Fix:_ return `() => clearInterval(id)` from the effect, and added
  `activeWorkspaceId` to `loadTasks`'s dependency array so it always queries
  the current workspace. Kept auto-refresh itself rather than removing it,
  it's the app's only way to pick up edits made elsewhere in the same
  workspace, and dropping a working feature is a bigger change than the bug
  calls for. Note: I would prefer having a button to refresh the task list
  manually instead of auto-refreshing every 5 seconds.
- _Refinement:_ switching workspaces used to briefly show the previous
  workspace's tasks (and search results) while the new fetch was in flight
  (a minor but real cross-tenant data leak in a multi-tenant UI). Added a small
  effect keyed only on `activeWorkspaceId` that clears `tasks` and
  `searchResults` the instant it changes, before the new fetch/search
  resolves, so nothing from the old workspace is ever visible against the new
  one. Also guarded `loadTasks` and the search effect to skip the Supabase
  call entirely (and keep the list empty) when `activeWorkspaceId` is `null`,
  and skip starting the polling interval in that case too.
- _Refinement, stale `loadTasks` responses:_ that clearing effect only closes
  the visible window; it doesn't stop a slow, older `loadTasks()` call from
  resolving _after_ a newer one (or after a workspace switch) and calling
  `setTasks(data)` with stale, wrong-workspace data. Unlike search, `loadTasks`
  is invoked from several places (initial load, the polling interval, every
  mutation) rather than one effect with a single cleanup, so there's no single
  place to `.abort()` the previous call. Instead, added a monotonically
  increasing request id in a ref: each call stamps its own id, and a response
  only touches state if its id still matches the latest one, so a late,
  outdated response is dropped instead of clobbering newer data.
- _Validated:_ `pnpm build`/`pnpm test` pass.
  _To confirm live:_
    - Switch workspaces 5+ times, watch the Network tab: requests stay at one
      per 5s (for the _current_ workspace), not growing with switch count.
      List should also go empty for a moment on switch, not show the old
      workspace's data.
    - Throttle the network, switch workspace A → B before A's load resolves.
      Expect: B's task list is never overwritten by A's (late) response.

**3. Stale closure in the title updater.**

- _Root cause:_ a `setInterval` effect with an empty dependency array
  captured `tasks` from the first render only, so the count shown in the
  title never moved (its cleanup was already correct, the empty deps array
  was the actual bug).
- _Fix:_ dropped the interval and set `document.title` directly in a
  `useEffect` keyed on `tasks.length`. No need to poll a value that's already
  available at render time.
- _Validated:_ `pnpm build`/`pnpm test` pass.
  _To confirm live:_ add or delete a task and see the title update
  immediately.

## 1b — Performance

- _Issue:_ `loadTasks` fetched the entire `tasks` table (`select('*')`, no
  `workspace_id` filter) and filtered down to the active workspace client-side
  in a `useMemo`. Network/database/client work scaled with tasks across _all_
  workspaces, not what's shown, and shipped every other workspace's task data
  to the browser on every load and every 5s poll.
- _How I spotted it:_ flagged directly in a code comment above `loadTasks`,
  and confirmed by reading the query, with no `.eq('workspace_id', …)` before the
  client-side filter.
- _Fix:_ added `.eq('workspace_id', activeWorkspaceId)` to the query and
  removed the now-redundant `useMemo` filter. State is exactly the active
  workspace's tasks, filtered in Postgres instead of in the browser. (RLS
  still enforces the same boundary server-side regardless of what the client
  asks for. This change is about not over-fetching, not access control.)
- _Secondary, not implemented:_ debouncing the search input (~250-300ms)
  would cut requests while typing, but it doesn't fix a correctness problem
  (that's the `abortSignal` fix above) and isn't worth it at the current data
  volume, worth revisiting if search traffic grows. Also skipped list
  virtualization: nothing measured suggests render cost is the bottleneck at
  current or near-term scale, and it adds real complexity for a problem that
  doesn't exist yet.
- _Before/after:_ with only two seeded workspaces this isn't a visible
  latency win yet, the real improvement is architectural (the network/database
  work per request now scales with the active workspace's tasks, not the whole
  table, including other workspaces' tasks).
  _To measure:_ seed one workspace with a few thousand tasks, then compare the
  `tasks` request's size/time in the Network tab while viewing a different,
  small workspace, before vs. after this change.

## 1c — Multi-tenancy & roles

**Tenancy strategy.** Shared tables (`workspaces`, `memberships`, `tasks`) with
a `workspace_id` column, isolated by Postgres/Supabase row-level security
(RLS), rather than schema-per-tenant or database-per-tenant. For a product at
this stage, shared tables + RLS keep operations, migrations, and querying
simple (one schema to evolve, one connection pool, easy cross-workspace admin
tooling), and they make onboarding a new workspace a single row insert instead
of provisioning a schema. (That insert itself is a privileged operation, not a
normal client-side call, see the bootstrapping note below.) Schema- or
database-per-tenant only earns its
operational cost when a customer needs hard physical isolation, per-tenant
schema customization, or a compliance requirement that shared storage can't
satisfy, none of which applies here.

**Enforcement (`supabase/policies/rls_policies.sql`).** RLS is enabled on all
three tables; every rule runs server-side and holds even if a client calls the
API directly with the anon key:

- `tasks` — any workspace member can `select`; `admin`/`member` can
  `insert`/`update`; only `admin` can `delete`.
- `memberships` — any workspace member can `select`; only `admin` can
  `insert`/`update`/`delete`, and only within their own workspace.
- `workspaces` — any workspace member can `select`; only `admin` can
  `update`/`delete`, and only their own workspace.

Two `security definer` helper functions, `is_workspace_member(ws)` and
`has_workspace_role(ws, roles)`, centralize the "is this user a member /
does this user have this role" checks. They query `memberships` directly
under elevated privilege, so the policies on `memberships` itself never need
to reference `memberships` again to evaluate, avoiding the infinite-recursion
trap of a table's RLS policy depending on a `select` against that same table.

Every `insert`/`update` policy pairs a `using` (or `with check`) clause with
the _same_ role/membership check applied to `workspace_id`. The `with check`
half is what stops a member from re-pointing an existing row, or inserting a
new one, into a workspace they don't belong to (e.g.
`insert into tasks (workspace_id, ...) values (<other workspace>, ...)`).
Without it, `using` alone would only guard reads/deletes of existing rows, not
the workspace_id value being written.

The UI's role-based button gating (hiding admin-only actions from
members/viewers) is kept as defense-in-depth for a better UX, but it is not a
security boundary, these RLS policies are the sole source of truth, and the
tests below prove the rules hold even when the UI is bypassed entirely.

**Bootstrapping note.** These policies deliberately have no path for an
ordinary signed-in user to create the _first_ workspace or membership for
themselves: there's no `workspaces_insert` policy, and `memberships_insert`
requires the caller to already be an `admin` of the target workspace. That's
intentional, a brand-new, membership-less user should not be able to grant
themselves admin over any workspace by self-inserting a row. Creating a
workspace and its first admin membership is therefore a privileged operation,
done via the seed script (`supabase/seed.sql`), the service-role key in a
trusted context, or a server-side function, never via a normal client-side
insert under RLS.

**Tests (`web/src/test/access-control.example.test.ts`).** Integration tests
against a real (disposable/local) Supabase project, exercising actual Auth +
RLS rather than mocks. `beforeAll` creates four real users via
`service.auth.admin.createUser` and seeds `memberships` linking them to two
workspaces (Acme, Globex) as `admin`, `member`, and `viewer`, then signs each
in through the anon client so their queries run under RLS as that user.
Covered cases:

- A Globex viewer cannot read Acme tasks (empty result, no error) but can read
  their own workspace's tasks.
- An Acme member cannot insert a task into Globex.
- An Acme viewer cannot insert, update, or delete tasks (read-only).
- An Acme member can create and edit tasks but cannot delete one or insert a
  membership (admin-only actions are denied).
- An Acme admin can create/update/delete tasks and add memberships within
  Acme, but cannot create a task or membership in Globex (admin power is
  scoped to their own workspace, not global).

Run with `pnpm test` (runs alongside the rest of the suite).

**Test environment.** Tests need `SUPABASE_URL` and `SUPABASE_ANON_KEY`
(anon key, used for the signed-in user clients so queries are actually
subject to RLS) plus a `SUPABASE_SERVICE_ROLE_KEY`, used only in test
setup/teardown (`web/.env`, read server-side by the test file) to create/delete
users and seed memberships. The service-role key bypasses RLS by design and
must never ship to browser code or be exposed with a `VITE_`-prefixed env var.
Point this at a disposable/local Supabase project, **NEVER a production**
project.

**Manual validation.** Before the RLS policies were applied, calling
`supabase.from('tasks').select().eq('workspace_id', ACME)` from a signed-in
Globex session returned Acme's tasks. After enabling RLS with the policies
above, the identical call returns zero rows (no error, just an empty result),
confirming isolation is enforced by Postgres itself and not just by the app's
query filters. (Example call below.)

```ts
useCallback(async () => {
    const { data, error } = await supabase
        .from('tasks')
        .select('*')
        .eq('workspace_id', '11111111-1111-1111-1111-111111111111')
    console.log({ data })
    console.log({ activeWorkspaceId })
}, [])()
```
