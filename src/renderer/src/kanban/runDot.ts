import type { RunStatus } from '../../../shared/domain'

/** Status → dot CSS class (colors defined in kanban.css). */
export const RUN_DOT_CLASS: Record<RunStatus, string> = {
  queued: 'dot-queued',
  running: 'dot-running',
  completed: 'dot-completed',
  failed: 'dot-failed',
  cancelled: 'dot-cancelled'
}
