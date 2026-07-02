import {
  closestCorners,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { useEffect, useMemo, useState } from 'react'
import type { TaskStatus } from '../../../shared/domain'
import '../assets/kanban.css'
import { bindBoardEvents, useBoardStore, type BoardTask } from '../state/boardStore'
import { Column, COLUMN_DROP_PREFIX } from './Column'
import { byPosition, matchesFilter, planDropPosition } from './ordering'
import { AddProjectButton, ProjectSwitcher } from './ProjectSwitcher'
import { TaskCardBody } from './TaskCard'
import { TaskDetailPanel } from './TaskDetailPanel'
import { Toasts } from './Toasts'
import { showError, showToast } from './toastStore'

const MAIN_STATUSES: TaskStatus[] = ['todo', 'inprogress', 'inreview', 'done']
const ALL_STATUSES: TaskStatus[] = [...MAIN_STATUSES, 'cancelled']

export function BoardPage(): React.JSX.Element {
  const loaded = useBoardStore((s) => s.loaded)
  const projects = useBoardStore((s) => s.projects)
  const activeProjectId = useBoardStore((s) => s.activeProjectId)
  const tasksById = useBoardStore((s) => s.tasksById)
  const filter = useBoardStore((s) => s.filter)
  const selectedTaskId = useBoardStore((s) => s.selectedTaskId)

  const [showCancelled, setShowCancelled] = useState(false)
  const [composing, setComposing] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [dragTask, setDragTask] = useState<BoardTask | null>(null)

  useEffect(() => {
    bindBoardEvents()
    useBoardStore
      .getState()
      .hydrate()
      .catch((err) => showError(err, 'Load board failed'))
  }, [])

  // Unfiltered ordered columns — drop-position math must see hidden cards too.
  const columns = useMemo(() => {
    const map = {} as Record<TaskStatus, BoardTask[]>
    for (const st of ALL_STATUSES) map[st] = []
    for (const t of Object.values(tasksById)) map[t.status]?.push(t)
    for (const st of ALL_STATUSES) map[st].sort(byPosition)
    return map
  }, [tasksById])

  const visibleStatuses = showCancelled ? ALL_STATUSES : MAIN_STATUSES

  // Distance threshold keeps plain clicks (open panel) from starting a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  function onDragStart(e: DragStartEvent): void {
    setDragTask(tasksById[String(e.active.id)] ?? null)
  }

  function onDragEnd(e: DragEndEvent): void {
    setDragTask(null)
    const { active, over } = e
    if (!over) return
    const activeId = String(active.id)
    const overId = String(over.id)
    const task = useBoardStore.getState().tasksById[activeId]
    if (!task || activeId === overId) return

    let targetStatus: TaskStatus
    let overTaskId: string | null
    if (overId.startsWith(COLUMN_DROP_PREFIX)) {
      targetStatus = overId.slice(COLUMN_DROP_PREFIX.length) as TaskStatus
      overTaskId = null
    } else {
      const overTask = useBoardStore.getState().tasksById[overId]
      if (!overTask) return
      targetStatus = overTask.status
      overTaskId = overId
    }

    const position = planDropPosition(activeId, overTaskId, columns[targetStatus])
    if (task.status === targetStatus && task.position === position) return
    void useBoardStore
      .getState()
      .moveTask(activeId, targetStatus, position)
      .then((res) => {
        if (!res.ok) showToast(res.reason)
      })
  }

  async function createTask(): Promise<void> {
    const projectId = useBoardStore.getState().activeProjectId
    const title = newTitle.trim()
    if (!projectId || !title) return
    try {
      const task = await window.orchebary.tasks.create({ projectId, title })
      useBoardStore.getState().applyEvent({ type: 'task.updated', task })
      setNewTitle('')
      setComposing(false)
    } catch (err) {
      showError(err, 'Create task failed')
    }
  }

  const selectedTask = selectedTaskId ? tasksById[selectedTaskId] : undefined

  return (
    <div className="kanban-root">
      <div className="kanban-header">
        <ProjectSwitcher />
        <input
          className="text-input kanban-filter"
          placeholder="Filter tasks…"
          value={filter}
          onChange={(e) => useBoardStore.getState().setFilter(e.target.value)}
        />
        <label className="kanban-toggle">
          <input
            type="checkbox"
            checked={showCancelled}
            onChange={(e) => setShowCancelled(e.target.checked)}
          />
          Show cancelled
        </label>
        <div className="kanban-header-spacer" />
        {activeProjectId &&
          (composing ? (
            <form
              className="kanban-newtask"
              onSubmit={(e) => {
                e.preventDefault()
                void createTask()
              }}
            >
              <input
                autoFocus
                className="text-input"
                placeholder="Task title…"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setComposing(false)
                    setNewTitle('')
                  }
                }}
              />
              <button type="submit" className="btn btn-primary" disabled={!newTitle.trim()}>
                Add
              </button>
            </form>
          ) : (
            <button className="btn btn-primary" onClick={() => setComposing(true)}>
              New task
            </button>
          ))}
      </div>

      {loaded && projects.length === 0 ? (
        <div className="kanban-empty">
          <div className="kanban-empty-title">No projects yet</div>
          <div className="kanban-empty-hint">
            Add a local git repository to start running agents against it.
          </div>
          <AddProjectButton primary />
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragTask(null)}
        >
          <div className="kanban-board">
            {visibleStatuses.map((st) => (
              <Column
                key={st}
                status={st}
                tasks={columns[st].filter((t) => matchesFilter(t.title, filter))}
              />
            ))}
          </div>
          <DragOverlay>
            {dragTask && (
              <div className="task-card task-card-overlay">
                <TaskCardBody task={dragTask} />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {selectedTask && <TaskDetailPanel key={selectedTask.id} task={selectedTask} />}
      <Toasts />
    </div>
  )
}
