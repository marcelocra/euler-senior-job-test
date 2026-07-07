import type { Role, Task, TaskStatus } from '../lib/types'

const STATUSES: TaskStatus[] = ['todo', 'in_progress', 'done']

interface Props {
  task: Task
  role: Role | null
  onChangeStatus: (id: string, status: TaskStatus) => void
  onDelete: (id: string) => void
  onToggleArchive: (id: string, archived: boolean) => void
}

export default function TaskItem({
  task,
  role,
  onChangeStatus,
  onDelete,
  onToggleArchive,
}: Props) {
  // UI gating as defense-in-depth for a better UX. The actual security
  // boundary is enforced server-side by RLS policies
  // (supabase/policies/rls_policies.sql), a viewer who bypasses the client
  // and calls the API directly is still denied there.
  const canWrite = role === 'admin' || role === 'member'
  const canDelete = role === 'admin'

  return (
    <div className="card task">
      <div>
        <div>{task.title}</div>
        <div className="meta">
          updated {new Date(task.updated_at).toLocaleString()}
        </div>
      </div>
      <div className="row">
        <span className={`badge ${task.status}`}>
          {task.status.replace('_', ' ')}
        </span>
        {task.archived && <span className="badge archived">Archived</span>}
        <select
          value={task.status}
          disabled={!canWrite}
          onChange={(e) =>
            onChangeStatus(task.id, e.target.value as TaskStatus)
          }
          aria-label={`Status for ${task.title}`}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </select>
        {canDelete && !task.archived && (
          <button
            onClick={() => onToggleArchive(task.id, true)}
            aria-label={`Archive ${task.title}`}
          >
            Archive
          </button>
        )}
        {canDelete && task.archived && (
          <button
            onClick={() => onToggleArchive(task.id, false)}
            aria-label={`Recover ${task.title}`}
          >
            Recover
          </button>
        )}
        <button
          disabled={!canDelete}
          onClick={() => onDelete(task.id)}
          aria-label={`Delete ${task.title}`}
        >
          Delete
        </button>
      </div>
    </div>
  )
}
