import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useBoardStore, type BoardTask } from '../state/boardStore'
import { RUN_DOT_CLASS } from './runDot'

/** Presentational card content, shared by the sortable card and the drag overlay. */
export function TaskCardBody({ task }: { task: BoardTask }): React.JSX.Element {
  const run = task.latestRun
  return (
    <>
      <div className="task-card-title">{task.title}</div>
      {(run || task.diffStat || task.remoteLink) && (
        <div className="task-card-chips">
          {run && (
            <span className={`chip run-pill run-${run.status}`}>
              <span className={`dot ${RUN_DOT_CLASS[run.status]}`} />
              {run.status}
            </span>
          )}
          {run?.branch && (
            <span className="chip chip-branch" title={run.branch}>
              {run.branch}
            </span>
          )}
          {task.diffStat && (
            <span className="chip chip-diff">
              <span className="diff-add">+{task.diffStat.additions}</span>
              <span className="diff-del">-{task.diffStat.deletions}</span>
            </span>
          )}
          {task.remoteLink && <span className="chip chip-jira">{task.remoteLink.remoteKey}</span>}
        </div>
      )}
    </>
  )
}

export function SortableTaskCard({ task }: { task: BoardTask }): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id
  })
  return (
    <div
      ref={setNodeRef}
      className={`task-card${isDragging ? ' task-card-dragging' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onClick={() => useBoardStore.getState().selectTask(task.id)}
      {...attributes}
      {...listeners}
    >
      <TaskCardBody task={task} />
    </div>
  )
}
