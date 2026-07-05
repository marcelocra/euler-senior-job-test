# PR #142 Review — Response

Add bulk task import and rich task descriptions.

**Verdict: Request changes.**

This PR ships a critical security vulnerability: client-side use of the Supabase
service-role key plus several correctness and robustness gaps in the bulk-import
flow. The rich description feature is close, but let's land it separately from
the import path once the security issue is fixed.

## Blocking (must fix before merge)

### 1. Service-role key shipped to the browser. Bypasses RLS for every visitor

`web/src/lib/adminClient.ts` reads `VITE_SUPABASE_SERVICE_ROLE_KEY` and constructs
a Supabase client with it. Any `VITE_`-prefixed variable is inlined into the
built JS bundle by Vite, so this key which bypasses **all** RLS policies would
be shipped to every browser that loads the app. Anyone who opens dev tools
or reads the bundle gets full read/write access to every workspace's data,
regardless of membership or role.

This isn't a theoretical concern: it directly undoes the workspace isolation and
role enforcement (`supabase/policies/rls_policies.sql`) that the rest of the app
relies on. The `.env.example` diff (adding `VITE_SUPABASE_SERVICE_ROLE_KEY`)
makes the problem discoverable/repeatable for anyone who follows the example,
so it needs to be reverted along with `adminClient.ts`.

**Fix:** move bulk import behind a server-side boundary that holds the
service-role (or elevated) credential, e.g. a Supabase Edge Function, and
have it:

- authenticate the caller's session (pass the user's JWT, verify with
  `supabase.auth.getUser()` or equivalent) rather than trusting the client,
- re-check workspace membership and role (admin/member, matching the
  existing `tasks_insert` RLS policy) before inserting, since a service-role
  client has no RLS net of its own,
- perform the insert with server-side validation on the payload.

The repo already has a good template for this shape in
`supabase/functions/admin-create-task/index.ts`. Extending that pattern (or a
similar backend route) for bulk rows is the right fix. The frontend should call
that function with the user's normal session, not talk to Postgres directly with
elevated credentials.

## High severity

### 2. Failures are swallowed and reported as success

In `BulkImport.tsx`:

```tsx
try {
    const { error } = await adminClient.from('tasks').insert(rows)
    if (error) throw error
    setStatus(`Imported ${rows.length} tasks`)
    setRaw('')
} catch {
    setStatus('Done')
}
```

If the insert fails, the user sees "Done", indistinguishable from success,
and `raw` is not cleared, but there's no indication anything went wrong. This
will hide real failures (e.g. RLS rejections once the key issue above is fixed,
network errors, validation errors) from the person who just tried to import
their data. Catch and surface the actual error (e.g.
`setStatus('Import failed: ' + error.message)`), and don't silently coerce
failure into a success-shaped message.

### 3. No row cap or abuse control

`raw.split('\n')` will happily turn a multi-thousand-line paste into a single
unbounded, client-controlled import payload. Even once this goes through a
server-side route, that route should enforce a reasonable max row count (and
reject/chunk oversized payloads). This was flagged as a known follow-up in the
PR description, but given the size of the write is entirely dictated by
client input, I'd treat it as required before merge rather than a
nice-to-have follow-up.

## Medium severity

### 4. Untrimmed titles and blank lines are inserted as-is

```tsx
const rows = raw.split('\n').map((title) => ({ ... title, ... }))
```

No `.trim()` on each line and no filtering of empty lines. A paste with a
trailing newline or blank lines in the middle will create tasks with empty or
whitespace-padded titles, and the reported count (`rows.length`) will
overcount actual meaningful imports. Compare with `TaskList.tsx`'s
`createTask`, which trims and guards against an empty title. Suggest:

```ts
const rows = raw
    .split('\n')
    .map((title) => title.trim())
    .filter(Boolean)
    .map((title) => ({ workspace_id: workspaceId, title, status: 'todo' }))
```

### 5. No loading/disabled state on import

The `Import` button stays enabled and clickable while the request is
in-flight, so a user can double-click (or click repeatedly on a slow network)
and fire duplicate inserts. Add a `submitting` state that disables the button
and/or shows a spinner, similar to the `loading` pattern already used in
`TaskList.tsx`.

### 6. Missing dependencies in `package.json`

`TaskDescription.tsx` imports `marked` and `dompurify`, but neither appears in
`web/package.json` (`dependencies` only lists `@supabase/supabase-js`, `react`,
`react-dom`, `react-router-dom`). As written, this either fails to build or is
relying on a hoisted/transient install that isn't guaranteed. Both should be
explicit dependencies (and `@types/dompurify` if not bundled) with pinned
versions.

## Low severity / nits

- `adminClient.ts`'s comment ("Uses elevated credentials so large imports and
  cross-workspace cleanups don't get blocked") reads like RLS is being treated
  as an obstacle rather than the isolation boundary, worth a second look at
  the underlying assumption once the fix above lands.
- Consider a max-length guard or character count on the textarea itself as a
  cheap first line of defense against oversized pastes, in addition to the
  server-side cap.

## Things that looked suspicious but are fine

- **Markdown rendering via `marked` + `DOMPurify`** (`TaskDescription.tsx`):
  parsing untrusted Markdown to HTML and injecting it via
  `dangerouslySetInnerHTML` is the kind of thing that deserves scrutiny, but
  sanitizing the _output_ HTML with `DOMPurify.sanitize()` right before render
  is the correct pattern and should neutralize injected `<script>`/event-handler
  payloads. This is acceptable as defense-in-depth **once the two packages are added to `package.json`**
  (see #6). It's not the risk that needs to block
  this PR, and it shouldn't distract from the service-role issue above.

## Requested changes summary

1. Remove `adminClient.ts` and the `VITE_SUPABASE_SERVICE_ROLE_KEY` addition to
   `.env.example` entirely. No service-role key in frontend code, ever.
2. Move bulk import to a server-side boundary (Edge Function or backend route)
   that authenticates the user's session and re-checks workspace role before
   inserting, following the pattern in `supabase/functions/admin-create-task`.
3. Fix error handling in `BulkImport` so failures are surfaced, not reported as
   "Done".
4. Trim titles, drop blank lines, and reconcile the reported count with what
   was actually inserted.
5. Add a request-in-flight/disabled state on the Import button.
6. Add a server-enforced row cap (and ideally a client-side soft limit).
7. Add `marked` and `dompurify` (+ types) to `web/package.json`.
