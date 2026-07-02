import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  EventChannel,
  Invokables,
  InvokeChannel,
  MainEvents,
  Sendables,
  SendChannel
} from '../shared/ipc'
import type {
  AgentKind,
  CreateTerminalRequest,
  HistoryEntry,
  ProjectSettings,
  TaskStatus
} from '../shared/domain'

// Fixed-channel wrappers only — the renderer never gets a generic
// invoke(channel, ...) passthrough, so a compromised renderer is limited to
// exactly this surface.
function invoke<K extends InvokeChannel>(
  channel: K,
  req: Invokables[K]['req']
): Promise<Invokables[K]['res']> {
  return ipcRenderer.invoke(channel, req)
}

function send<K extends SendChannel>(channel: K, payload: Sendables[K]): void {
  ipcRenderer.send(channel, payload)
}

function subscribe<K extends EventChannel>(
  channel: K,
  cb: (payload: MainEvents[K]) => void
): () => void {
  const listener = (_e: IpcRendererEvent, payload: MainEvents[K]): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api = {
  ping: () => invoke('app:ping', undefined),

  terminal: {
    create: (req: CreateTerminalRequest) => invoke('terminal:create', req),
    resize: (sessionId: string, cols: number, rows: number) =>
      invoke('terminal:resize', { sessionId, cols, rows }),
    kill: (sessionId: string) => invoke('terminal:kill', { sessionId }),
    list: () => invoke('terminal:list', undefined),
    input: (sessionId: string, data: string) => send('terminal:input', { sessionId, data }),
    ack: (sessionId: string, bytes: number) => send('terminal:ack', { sessionId, bytes }),
    onData: (cb: (p: MainEvents['terminal:data']) => void) => subscribe('terminal:data', cb),
    onExit: (cb: (p: MainEvents['terminal:exit']) => void) => subscribe('terminal:exit', cb)
  },

  projects: {
    list: () => invoke('projects:list', undefined),
    create: (name: string, repoPath: string) => invoke('projects:create', { name, repoPath }),
    update: (id: string, patch: { name?: string; baseBranch?: string; settings?: Partial<ProjectSettings> }) =>
      invoke('projects:update', { id, patch }),
    archive: (id: string) => invoke('projects:archive', { id })
  },

  tasks: {
    list: (projectId: string) => invoke('tasks:list', { projectId }),
    create: (req: { projectId: string; title: string; description?: string; status?: TaskStatus }) =>
      invoke('tasks:create', req),
    update: (id: string, patch: { title?: string; description?: string }) =>
      invoke('tasks:update', { id, patch }),
    move: (req: { id: string; status: TaskStatus; position: string; expectedRev: number }) =>
      invoke('tasks:move', req),
    delete: (id: string) => invoke('tasks:delete', { id })
  },

  runs: {
    start: (req: { taskId: string; agentKind?: AgentKind; prompt?: string }) =>
      invoke('runs:start', req),
    followUp: (taskId: string, prompt: string) => invoke('runs:followUp', { taskId, prompt }),
    cancel: (runId: string) => invoke('runs:cancel', { runId }),
    listForTask: (taskId: string) => invoke('runs:listForTask', { taskId }),
    readLog: (runId: string, offset?: number, limit?: number) =>
      invoke('runs:readLog', { runId, offset, limit })
  },

  git: {
    diff: (runId: string) => invoke('git:diff', { runId }),
    diffStat: (runId: string) => invoke('git:diffStat', { runId }),
    merge: (runId: string) => invoke('git:merge', { runId })
  },

  worktree: {
    openInTerminal: (runId: string, cols: number, rows: number) =>
      invoke('worktree:openInTerminal', { runId, cols, rows }),
    remove: (runId: string, deleteBranch: boolean) =>
      invoke('worktree:remove', { runId, deleteBranch })
  },

  agents: {
    listAvailable: () => invoke('agents:listAvailable', undefined)
  },

  history: {
    search: (req: { query: string; sessionId?: string; projectRoot?: string; limit?: number }) =>
      invoke('history:search', req),
    append: (entry: Omit<HistoryEntry, 'id'>) => send('history:append', entry)
  },

  settings: {
    get: (key: string) => invoke('settings:get', { key }),
    set: (key: string, value: unknown) => invoke('settings:set', { key, value })
  },

  dialog: {
    pickDirectory: () => invoke('dialog:pickDirectory', undefined)
  },

  onAppEvent: (cb: (p: MainEvents['app:event']) => void) => subscribe('app:event', cb)
}

export type OrchebaryApi = typeof api

contextBridge.exposeInMainWorld('orchebary', api)
