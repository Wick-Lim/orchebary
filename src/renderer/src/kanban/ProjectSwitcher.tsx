import { useState } from 'react'
import { useBoardStore } from '../state/boardStore'
import { showError } from './toastStore'

function dirName(p: string): string {
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || p
}

/** Pick-directory → inline name form → projects:create. Reused by the empty state. */
export function AddProjectButton({ primary = false }: { primary?: boolean }): React.JSX.Element {
  const [pending, setPending] = useState<{ path: string; name: string } | null>(null)

  async function pickFolder(): Promise<void> {
    try {
      const res = await window.orchebary.dialog.pickDirectory()
      if (res) setPending({ path: res.path, name: dirName(res.path) })
    } catch (err) {
      showError(err, 'Pick folder failed')
    }
  }

  async function createProject(): Promise<void> {
    if (!pending || !pending.name.trim()) return
    try {
      const project = await window.orchebary.projects.create(pending.name.trim(), pending.path)
      setPending(null)
      await useBoardStore.getState().hydrate(project.id)
    } catch (err) {
      showError(err, 'Add project failed')
    }
  }

  if (!pending) {
    return (
      <button className={`btn${primary ? ' btn-primary' : ''}`} onClick={() => void pickFolder()}>
        Add project
      </button>
    )
  }
  return (
    <form
      className="project-add-form"
      onSubmit={(e) => {
        e.preventDefault()
        void createProject()
      }}
    >
      <input
        autoFocus
        className="text-input"
        value={pending.name}
        placeholder="Project name"
        onChange={(e) => setPending({ ...pending, name: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setPending(null)
        }}
      />
      <span className="project-add-path" title={pending.path}>
        {pending.path}
      </span>
      <button type="submit" className="btn btn-primary" disabled={!pending.name.trim()}>
        Create
      </button>
      <button type="button" className="btn" onClick={() => setPending(null)}>
        Cancel
      </button>
    </form>
  )
}

export function ProjectSwitcher(): React.JSX.Element {
  const projects = useBoardStore((s) => s.projects)
  const activeProjectId = useBoardStore((s) => s.activeProjectId)

  return (
    <div className="project-switcher">
      {projects.length > 0 && (
        <select
          className="project-select"
          value={activeProjectId ?? ''}
          onChange={(e) => {
            void useBoardStore
              .getState()
              .selectProject(e.target.value)
              .catch((err) => showError(err, 'Load project failed'))
          }}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      <AddProjectButton />
    </div>
  )
}
