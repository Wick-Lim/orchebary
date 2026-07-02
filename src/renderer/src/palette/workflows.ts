// Workflow snippets stored under the 'workflows' settings key:
//   [{ name, command, params?: [{ name, prompt, default? }] }]

export interface WorkflowParam {
  name: string
  prompt: string
  default?: string
}

export interface Workflow {
  name: string
  command: string
  params?: WorkflowParam[]
}

let cache: Workflow[] = []

export function cachedWorkflows(): Workflow[] {
  return cache
}

export async function refreshWorkflows(): Promise<Workflow[]> {
  const raw = await window.orchebary.settings.get('workflows')
  cache = parseWorkflows(raw)
  return cache
}

/** Settings are user-editable JSON — accept only well-shaped entries. */
export function parseWorkflows(raw: unknown): Workflow[] {
  if (!Array.isArray(raw)) return []
  const out: Workflow[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const { name, command, params } = item as Record<string, unknown>
    if (typeof name !== 'string' || !name || typeof command !== 'string' || !command) continue
    const wf: Workflow = { name, command }
    if (Array.isArray(params)) {
      const parsed: WorkflowParam[] = []
      for (const p of params) {
        if (typeof p !== 'object' || p === null) continue
        const { name: pName, prompt, default: def } = p as Record<string, unknown>
        if (typeof pName !== 'string' || !pName) continue
        parsed.push({
          name: pName,
          prompt: typeof prompt === 'string' && prompt ? prompt : pName,
          default: typeof def === 'string' ? def : undefined
        })
      }
      if (parsed.length > 0) wf.params = parsed
    }
    out.push(wf)
  }
  return out
}

/** Replace {{name}} / {{ name }} placeholders with the collected values. */
export function substituteParams(command: string, values: Record<string, string>): string {
  return command.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key: string) => values[key] ?? match)
}

/** No trailing newline: the user reviews the command and hits Enter. */
export function sendWorkflowCommand(sessionId: string, command: string): void {
  window.orchebary.terminal.input(sessionId, command)
}
