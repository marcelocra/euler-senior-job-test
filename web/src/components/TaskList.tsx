import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import type { Task, TaskStatus } from '../lib/types'
import { useWorkspace } from '../context/WorkspaceContext'
import TaskItem from './TaskItem'

export default function TaskList() {
  const { activeWorkspaceId, activeRole } = useWorkspace()
  const [tasks, setTasks] = useState<Task[]>([])
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<Task[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const canWrite = activeRole === 'admin' || activeRole === 'member'
  const isAdmin = activeRole === 'admin'

  // Clear anything from the previous workspace the instant it changes, so
  // there's no gap where the new workspace's view still shows old data while
  // the fresh fetch/search below are in flight.
  useEffect(() => {
    setTasks([])
    setSearchResults(null)
  }, [activeWorkspaceId])

  // Scoped to the active workspace at the query level, so cost tracks what's
  // shown instead of the total number of tasks across every workspace. No
  // workspace selected (e.g. between sign-in and workspaces loading) means no
  // query at all (the list just stays empty).
  //
  // Guarded by `loadRequestIdRef` against the same stale-response race as the
  // search effect: `loadTasks` gets called from multiple places (the initial
  // effect, the polling interval, and every mutation) rather than a single
  // effect with a cleanup, so there's no one place to run `.abort()` on the
  // previous request. A monotonically increasing request id serves the same
  // purpose: each call stamps its own id, and only the response matching the
  // current id (i.e. the most recently started call) is allowed to touch
  // state, so a slow response from before a workspace switch (or before a
  // newer call) can never land after and clobber a newer one.
  const loadRequestIdRef = useRef(0)
  const loadTasks = useCallback(async () => {
    if (!activeWorkspaceId) {
      loadRequestIdRef.current += 1
      setTasks([])
      setLoading(false)
      return
    }
    const requestId = ++loadRequestIdRef.current
    setLoading(true)
    let query = supabase
      .from('tasks')
      .select('*')
      .eq('workspace_id', activeWorkspaceId)
    if (!showArchived) {
      query = query.eq('archived', false)
    }
    const { data, error } = await query.order('created_at', { ascending: false })
    if (loadRequestIdRef.current !== requestId) return
    if (error) {
      console.error('Failed to load tasks', error)
    } else if (data) {
      setTasks(data as Task[])
    }
    setLoading(false)
  }, [activeWorkspaceId, showArchived])

  useEffect(() => {
    void loadTasks()
  }, [loadTasks])

  // Auto-refresh so edits made elsewhere in the same workspace show up
  // without a manual reload. `loadTasks` changes identity on every workspace
  // switch, so this effect re-runs then too (the returned cleanup clears the
  // previous interval each time and on unmount, so they never pile up. No
  // point polling when there's no workspace to poll for.
  useEffect(() => {
    if (!activeWorkspaceId) return
    const id = setInterval(() => {
      void loadTasks()
    }, 5000)
    return () => clearInterval(id)
  }, [activeWorkspaceId, loadTasks])

  // Each run gets its own AbortController, and the previous request (if any)
  // is cancelled whenever the term/workspace changes or the component
  // unmounts. Checking `aborted` in the callback too means a slow, now-stale
  // response can never land after (and clobber) a newer one. With no
  // workspace selected, or an empty term, there's nothing to search for.
  // TODO(later): Debounce the search.
  useEffect(() => {
    const term = search.trim()
    if (!term || !activeWorkspaceId) {
      setSearchResults(null)
      return
    }
    const controller = new AbortController()
    let query = supabase
      .from('tasks')
      .select('*')
      .eq('workspace_id', activeWorkspaceId)
      .ilike('title', `%${term}%`)
    if (!showArchived) {
      query = query.eq('archived', false)
    }
    query
      .order('created_at', { ascending: false })
      .abortSignal(controller.signal)
      .then(({ data, error }) => {
        if (controller.signal.aborted) return
        if (error) {
          console.error('Failed to search tasks', error)
          return
        }
        setSearchResults((data ?? []) as Task[])
      })
    return () => controller.abort()
  }, [search, activeWorkspaceId, showArchived])

  // Sync the title directly off the count on every change, instead of
  // polling a value that's already available at render time.
  useEffect(() => {
    document.title = `Nimbus — ${tasks.length} tasks`
  }, [tasks.length])

  async function createTask(e: FormEvent) {
    e.preventDefault()
    const title = newTitle.trim()
    if (!title || !activeWorkspaceId) return
    const { error } = await supabase
      .from('tasks')
      .insert({ workspace_id: activeWorkspaceId, title, status: 'todo' })
    if (error) {
      console.error('Failed to create task', error)
      return
    }
    setNewTitle('')
    void loadTasks()
  }

  async function changeStatus(id: string, status: TaskStatus) {
    const { error } = await supabase
      .from('tasks')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) {
      console.error('Failed to update task', error)
      return
    }
    void loadTasks()
  }

  async function deleteTask(id: string) {
    const { error } = await supabase.from('tasks').delete().eq('id', id)
    if (error) {
      console.error('Failed to delete task', error)
      return
    }
    void loadTasks()
  }

  async function setArchived(id: string, archived: boolean) {
    const { error } = await supabase
      .from('tasks')
      .update({
        archived,
        archived_at: archived ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
    if (error) {
      console.error('Failed to update archive status', error)
      return
    }
    void loadTasks()
  }

  const visible = searchResults ?? tasks

  return (
    <div>
      {canWrite && (
        <form className="toolbar" onSubmit={createTask}>
          <input
            type="text"
            placeholder="New task title…"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <button className="primary" type="submit">
            Add task
          </button>
        </form>
      )}

      <div className="toolbar">
        <input
          type="search"
          placeholder="Search tasks…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {isAdmin && (
          <label className="row">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
        )}
        {loading && <span className="muted">Loading…</span>}
      </div>

      {visible.length === 0 ? (
        <p className="muted">
          No tasks{search ? ' match your search' : ' yet'}.
        </p>
      ) : (
        visible.map((task) => (
          <TaskItem
            key={task.id}
            task={task}
            role={activeRole}
            onChangeStatus={changeStatus}
            onDelete={deleteTask}
            onToggleArchive={setArchived}
          />
        ))
      )}
    </div>
  )
}
