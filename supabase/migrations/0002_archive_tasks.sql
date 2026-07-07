-- Nimbus — add task archiving
--
-- Adds an `archived` flag so tasks can be hidden from the default list.
-- Archived tasks are fully admin-only (view/edit/recover/delete), enforced
-- by RLS policies in supabase/policies/rls_policies.sql.

alter table public.tasks
  add column if not exists archived boolean not null default false;

alter table public.tasks
  add column if not exists archived_at timestamptz;

create index if not exists tasks_workspace_archived_idx
  on public.tasks (workspace_id, archived);
