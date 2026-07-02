import { useLayoutStore } from '../state/layoutStore'
import { CommandPalette } from './CommandPalette'
import { WorkflowParamsModal } from './WorkflowParamsModal'

/** Mounts the palette + workflow-params overlays once, above both views. */
export function PaletteHost(): React.JSX.Element {
  const pendingWorkflow = useLayoutStore((s) => s.pendingWorkflow)
  return (
    <>
      <CommandPalette />
      {pendingWorkflow && (
        <WorkflowParamsModal key={pendingWorkflow.name} workflow={pendingWorkflow} />
      )}
    </>
  )
}
