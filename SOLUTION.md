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
- _Validated:_ `pnpm build` and `pnpm test` pass; traced the effect's
  abort/cleanup ordering by hand for out-of-order responses. To confirm live:
  throttle the network, type a term, then change it before the response
  returns. Network tab should show the first request `(canceled)`, and the
  list should only ever match the last term typed.

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
- _Validated:_ `pnpm build` and `pnpm test` pass. To confirm live: switch
  workspaces 5+ times and watch the Network tab. Requests should stay at one
  per 5s (for the _current_ workspace), not grow with the number of switches.
  Also watch the task list while switching, it should go empty for a moment
  rather than showing the old workspace's tasks/search matches.

**3. Stale closure in the title updater.**

- _Root cause:_ a `setInterval` effect with an empty dependency array
  captured `tasks` from the first render only, so the count shown in the
  title never moved (its cleanup was already correct, the empty deps array
  was the actual bug).
- _Fix:_ dropped the interval and set `document.title` directly in a
  `useEffect` keyed on `tasks.length`. No need to poll a value that's already
  available at render time.
- _Validated:_ `pnpm build` and `pnpm test` pass. To confirm live: add or
  delete a task and see the title update immediately.

## 1b — Performance

- _Issue:_ `loadTasks` fetched the entire `tasks` table (`select('*')`, no
  `workspace_id` filter) and filtered down to the active workspace client-side
  in a `useMemo`. Cost scaled with tasks across _all_ workspaces, not what's
  shown, and shipped every other workspace's task data to the browser on
  every load and every 5s poll.
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
  latency win yet, the real improvement is architectural (request cost now
  scales with the active workspace's tasks, not the whole table, including other
  workspaces' tasks). To measure: seed one workspace with a few thousand tasks,
  then compare the `tasks` request's size/time in the Network tab while viewing
  a different, small workspace, before vs. after this change.

## 1c — Multi-tenancy & roles

<!--
- Where isolation and role enforcement live (the RLS policies), and how they
  hold even if the client is bypassed.
- Your tenancy-strategy note: shared tables + RLS vs schema-per-tenant vs
  DB-per-tenant — what you chose and why.
- How to run your access-control tests.
-->

_Your tenancy strategy, enforcement points, and how to run the tests._
