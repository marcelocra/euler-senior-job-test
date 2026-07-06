-- ===========================================================================
-- Task 1c — Workspace isolation & roles
-- ===========================================================================
-- The starter ships with RLS disabled (see migrations/0001_init.sql) so any
-- signed-in user can touch any workspace's data. These policies enforce, at
-- the database level,
--
--   1. Isolation — a user only ever sees/affects workspaces they belong to.
--   2. Roles — admin (manage members + all data), member (create/edit),
--      viewer (read-only).
--
-- Enforced in RLS policies (server-side). The UI also gates buttons by role
-- as defense-in-depth, but UI gating alone is not a security boundary — the
-- rules below hold even if someone calls the API directly with the anon key.
--
-- See SOLUTION.md (Task 1c) for the tenancy strategy and rationale, and
-- web/src/test/access-control.example.test.ts for the automated tests
-- proving these rules.
--
-- Apply this file in the Supabase SQL editor.
-- ---------------------------------------------------------------------------

create or replace function public.is_workspace_member(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    where m.workspace_id = ws
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.has_workspace_role(
  ws uuid,
  roles public.user_role[]
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    where m.workspace_id = ws
      and m.user_id = auth.uid()
      and m.role = any(roles)
  );
$$;

alter table public.workspaces enable row level security;
alter table public.memberships enable row level security;
alter table public.tasks enable row level security;

drop policy if exists tasks_select on public.tasks;
drop policy if exists tasks_insert on public.tasks;
drop policy if exists tasks_update on public.tasks;
drop policy if exists tasks_delete on public.tasks;

create policy tasks_select
on public.tasks
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy tasks_insert
on public.tasks
for insert
to authenticated
with check (
  public.has_workspace_role(
    workspace_id,
    array['admin', 'member']::public.user_role[]
  )
);

create policy tasks_update
on public.tasks
for update
to authenticated
using (
  public.has_workspace_role(
    workspace_id,
    array['admin', 'member']::public.user_role[]
  )
)
with check (
  public.has_workspace_role(
    workspace_id,
    array['admin', 'member']::public.user_role[]
  )
);

create policy tasks_delete
on public.tasks
for delete
to authenticated
using (
  public.has_workspace_role(
    workspace_id,
    array['admin']::public.user_role[]
  )
);

drop policy if exists memberships_select on public.memberships;
drop policy if exists memberships_insert on public.memberships;
drop policy if exists memberships_update on public.memberships;
drop policy if exists memberships_delete on public.memberships;

create policy memberships_select
on public.memberships
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy memberships_insert
on public.memberships
for insert
to authenticated
with check (
  public.has_workspace_role(
    workspace_id,
    array['admin']::public.user_role[]
  )
);

create policy memberships_update
on public.memberships
for update
to authenticated
using (
  public.has_workspace_role(
    workspace_id,
    array['admin']::public.user_role[]
  )
)
with check (
  public.has_workspace_role(
    workspace_id,
    array['admin']::public.user_role[]
  )
);

create policy memberships_delete
on public.memberships
for delete
to authenticated
using (
  public.has_workspace_role(
    workspace_id,
    array['admin']::public.user_role[]
  )
);

drop policy if exists workspaces_select on public.workspaces;
drop policy if exists workspaces_update on public.workspaces;
drop policy if exists workspaces_delete on public.workspaces;

create policy workspaces_select
on public.workspaces
for select
to authenticated
using (public.is_workspace_member(id));

create policy workspaces_update
on public.workspaces
for update
to authenticated
using (
  public.has_workspace_role(
    id,
    array['admin']::public.user_role[]
  )
)
with check (
  public.has_workspace_role(
    id,
    array['admin']::public.user_role[]
  )
);

create policy workspaces_delete
on public.workspaces
for delete
to authenticated
using (
  public.has_workspace_role(
    id,
    array['admin']::public.user_role[]
  )
);