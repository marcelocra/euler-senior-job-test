export type Role = 'admin' | 'member' | 'viewer'

export type TaskStatus = 'todo' | 'in_progress' | 'done'

export interface Workspace {
  id: string
  name: string
  created_at: string
}

export interface Membership {
  id: string
  user_id: string
  workspace_id: string
  role: Role
}

export interface Task {
  id: string
  workspace_id: string
  title: string
  status: TaskStatus
  assignee_id: string | null
  archived: boolean
  archived_at: string | null
  created_at: string
  updated_at: string
}

// A workspace joined with the current user's role in it.
export interface WorkspaceWithRole extends Workspace {
  role: Role
}
