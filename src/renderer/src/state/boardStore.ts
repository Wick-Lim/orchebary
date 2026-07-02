import { create } from 'zustand'
import type { AppEvent, Project, Task, TaskRunSummary, TaskStatus } from '../../../shared/domain'

/** Task as held on the board: the wire Task plus the optimistic-concurrency rev. */
export type BoardTask = Task & { rev: number }

export type MoveOutcome = { ok: true; rev: number } | { ok: false; reason: string }

interface BoardState {
  projects: Project[]
  activeProjectId: string | null
  tasksById: Record<string, BoardTask>
  filter: string
  loaded: boolean
  selectedTaskId: string | null

  /** Load projects (optionally selecting one) and the active project's tasks. */
  hydrate: (projectId?: string) => Promise<void>
  selectProject: (projectId: string) => Promise<void>
  setFilter: (filter: string) => void
  selectTask: (taskId: string | null) => void
  /** Idempotent reducer for live app events (also fed with invoke responses). */
  applyEvent: (e: AppEvent) => void
  /** Optimistic move: applies locally, calls main, restores the snapshot on failure. */
  moveTask: (id: string, status: TaskStatus, position: string) => Promise<MoveOutcome>
}

// tasks:list / task.updated payloads carry `rev` at runtime (TaskStore joins it);
// the wire type is plain Task, so we widen in exactly one place.
function withRev(task: Task, fallback: number): BoardTask {
  const rev = (task as BoardTask).rev
  return { ...task, rev: typeof rev === 'number' ? rev : fallback }
}

function indexTasks(tasks: Task[]): Record<string, BoardTask> {
  return Object.fromEntries(tasks.map((t) => [t.id, withRev(t, 0)]))
}

export const useBoardStore = create<BoardState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  tasksById: {},
  filter: '',
  loaded: false,
  selectedTaskId: null,

  hydrate: async (projectId) => {
    const projects = await window.orchebary.projects.list()
    const preferred = projectId ?? get().activeProjectId ?? undefined
    const active = projects.find((p) => p.id === preferred) ?? projects[0]
    const tasks = active ? await window.orchebary.tasks.list(active.id) : []
    set({
      projects,
      activeProjectId: active?.id ?? null,
      tasksById: indexTasks(tasks),
      loaded: true
    })
  },

  selectProject: async (projectId) => {
    set({ activeProjectId: projectId, tasksById: {}, selectedTaskId: null })
    const tasks = await window.orchebary.tasks.list(projectId)
    if (get().activeProjectId !== projectId) return // switched again mid-flight
    set({ tasksById: indexTasks(tasks) })
  },

  setFilter: (filter) => set({ filter }),
  selectTask: (taskId) => set({ selectedTaskId: taskId }),

  applyEvent: (e) => {
    const s = get()
    switch (e.type) {
      case 'task.updated': {
        if (e.task.projectId !== s.activeProjectId) return
        const prev = s.tasksById[e.task.id]
        const next = withRev(e.task, prev?.rev ?? 0)
        if (prev && next.rev < prev.rev) return // stale echo of an older mutation
        if (next.deletedAt) {
          if (!prev) return
          const rest = { ...s.tasksById }
          delete rest[next.id]
          set({
            tasksById: rest,
            selectedTaskId: s.selectedTaskId === next.id ? null : s.selectedTaskId
          })
          return
        }
        set({ tasksById: { ...s.tasksById, [next.id]: next } })
        return
      }
      case 'task.moved': {
        const prev = s.tasksById[e.taskId]
        if (!prev || e.rev < prev.rev) return
        set({
          tasksById: {
            ...s.tasksById,
            [e.taskId]: { ...prev, status: e.status, position: e.position, rev: e.rev }
          }
        })
        return
      }
      case 'task.deleted': {
        if (!s.tasksById[e.taskId]) return
        const rest = { ...s.tasksById }
        delete rest[e.taskId]
        set({
          tasksById: rest,
          selectedTaskId: s.selectedTaskId === e.taskId ? null : s.selectedTaskId
        })
        return
      }
      case 'run.status': {
        const prev = s.tasksById[e.run.taskId]
        if (!prev) return
        const latestRun: TaskRunSummary = {
          id: e.run.id,
          agentKind: e.run.agentKind,
          status: e.run.status,
          branch: e.run.branch,
          startedAt: e.run.startedAt,
          finishedAt: e.run.finishedAt,
          summary: e.run.summary
        }
        set({ tasksById: { ...s.tasksById, [prev.id]: { ...prev, latestRun } } })
        return
      }
      case 'run.diffstat': {
        const prev = s.tasksById[e.taskId]
        if (!prev) return
        set({ tasksById: { ...s.tasksById, [prev.id]: { ...prev, diffStat: e.stat } } })
        return
      }
      default:
        return
    }
  },

  moveTask: async (id, status, position) => {
    const snapshot = get().tasksById
    const task = snapshot[id]
    if (!task) return { ok: false, reason: 'unknown task' }
    // Optimistic: rev stays unchanged until main acks with the new one.
    set({ tasksById: { ...snapshot, [id]: { ...task, status, position } } })
    try {
      const res = await window.orchebary.tasks.move({ id, status, position, expectedRev: task.rev })
      if (!res.ok) {
        set({ tasksById: snapshot })
        return res
      }
      const cur = get().tasksById[id]
      if (cur && cur.rev < res.rev) {
        set({ tasksById: { ...get().tasksById, [id]: { ...cur, rev: res.rev } } })
      }
      return res
    } catch (err) {
      set({ tasksById: snapshot })
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }
}))

let eventsBound = false

/** Subscribe the store to app events exactly once per renderer lifetime. */
export function bindBoardEvents(): void {
  if (eventsBound) return
  eventsBound = true
  window.orchebary.onAppEvent((e) => useBoardStore.getState().applyEvent(e))
}
