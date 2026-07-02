import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { TASK_STATUS_LABEL, type TaskStatus } from '../../../shared/domain'
import type { BoardTask } from '../state/boardStore'
import { SortableTaskCard } from './TaskCard'

export const COLUMN_DROP_PREFIX = 'column:'

export function Column({
  status,
  tasks
}: {
  status: TaskStatus
  tasks: BoardTask[]
}): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: COLUMN_DROP_PREFIX + status })
  return (
    <div className={`kanban-column${isOver ? ' kanban-column-over' : ''}`}>
      <div className="kanban-column-header">
        <span className="kanban-column-title">{TASK_STATUS_LABEL[status]}</span>
        <span className="kanban-column-count">{tasks.length}</span>
      </div>
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="kanban-column-body">
          {tasks.map((t) => (
            <SortableTaskCard key={t.id} task={t} />
          ))}
          {tasks.length === 0 && <div className="kanban-column-empty">No tasks</div>}
        </div>
      </SortableContext>
    </div>
  )
}
