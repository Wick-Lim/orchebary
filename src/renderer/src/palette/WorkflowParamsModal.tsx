import { useState } from 'react'
import { useLayoutStore } from '../state/layoutStore'
import { currentActionContext } from './actions'
import { sendWorkflowCommand, substituteParams, type Workflow } from './workflows'

/** Small form collecting {{param}} values before pasting a workflow command. */
export function WorkflowParamsModal({ workflow }: { workflow: Workflow }): React.JSX.Element {
  const params = workflow.params ?? []
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(params.map((p) => [p.name, p.default ?? '']))
  )

  const close = (): void => useLayoutStore.getState().setPendingWorkflow(null)

  const submit = (): void => {
    const sessionId = currentActionContext().activeSessionId
    if (sessionId) {
      sendWorkflowCommand(sessionId, substituteParams(workflow.command, values))
    }
    close()
  }

  return (
    <div
      className="overlay-backdrop"
      onMouseDown={close}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          close()
        }
      }}
    >
      <form
        className="workflow-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <h2>{workflow.name}</h2>
        <code className="workflow-command">{substituteParams(workflow.command, values)}</code>
        {params.map((param, i) => (
          <label key={param.name} className="workflow-field">
            <span>{param.prompt}</span>
            <input
              autoFocus={i === 0}
              value={values[param.name] ?? ''}
              spellCheck={false}
              onChange={(e) => setValues((prev) => ({ ...prev, [param.name]: e.target.value }))}
            />
          </label>
        ))}
        <div className="workflow-actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Paste to Terminal
          </button>
        </div>
      </form>
    </div>
  )
}
