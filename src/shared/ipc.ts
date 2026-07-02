// Typed IPC contract between main, preload, and renderer.
// Types only — no runtime imports.

import type {
  AgentAvailability,
  AgentKind,
  AppEvent,
  CreateTerminalRequest,
  DiffStat,
  FileDiff,
  HistoryEntry,
  Project,
  ProjectSettings,
  Task,
  TaskRun,
  TaskStatus,
  TerminalSessionInfo,
  WorktreeEntry
} from './domain'

/** Request/response channels (ipcRenderer.invoke / ipcMain.handle). */
export interface Invokables {
  'app:ping': { req: void; res: { pong: true; version: string } }

  'terminal:create': { req: CreateTerminalRequest; res: TerminalSessionInfo }
  'terminal:resize': { req: { sessionId: string; cols: number; rows: number }; res: void }
  'terminal:kill': { req: { sessionId: string }; res: void }
  'terminal:list': { req: void; res: TerminalSessionInfo[] }

  'projects:list': { req: void; res: Project[] }
  'projects:create': { req: { name: string; repoPath: string }; res: Project }
  'projects:update': {
    req: { id: string; patch: Partial<Pick<Project, 'name' | 'baseBranch'>> & { settings?: Partial<ProjectSettings> } }
    res: Project
  }
  'projects:archive': { req: { id: string }; res: void }

  'tasks:list': { req: { projectId: string }; res: Task[] }
  /**
   * "Working on" = in-progress tasks plus any task that still has a live
   * terminal session (e.g. a worktree shell opened during review). Feeds the
   * terminal-side rail.
   */
  'tasks:listWorkingOn': { req: void; res: Array<Task & { projectName: string }> }
  'tasks:create': {
    req: { projectId: string; title: string; description?: string; status?: TaskStatus }
    res: Task
  }
  'tasks:update': {
    req: { id: string; patch: Partial<Pick<Task, 'title' | 'description'>> }
    res: Task
  }
  'tasks:move': {
    req: { id: string; status: TaskStatus; position: string; expectedRev: number }
    res: { ok: true; rev: number } | { ok: false; reason: string }
  }
  'tasks:delete': { req: { id: string }; res: void }

  'runs:start': { req: { taskId: string; agentKind?: AgentKind; prompt?: string }; res: TaskRun }
  'runs:followUp': { req: { taskId: string; prompt: string }; res: TaskRun }
  'runs:cancel': { req: { runId: string }; res: void }
  'runs:listForTask': { req: { taskId: string }; res: TaskRun[] }
  'runs:readLog': {
    req: { runId: string; offset?: number; limit?: number }
    res: { events: import('./domain').AgentEvent[]; total: number }
  }

  'git:diff': { req: { runId: string }; res: { files: FileDiff[] } }
  'git:diffStat': { req: { runId: string }; res: DiffStat }
  'git:merge': {
    req: { runId: string }
    res: { ok: true } | { ok: false; conflict: boolean; detail: string }
  }

  'worktree:openInTerminal': { req: { runId: string; cols: number; rows: number }; res: TerminalSessionInfo }
  'worktree:remove': { req: { runId: string; deleteBranch: boolean }; res: void }
  /** Every managed worktree across projects (+ ghost directories on disk). */
  'worktree:listAll': { req: void; res: WorktreeEntry[] }
  /** Delete a ghost worktree directory and prune its project's registry. */
  'worktree:pruneGhost': { req: { path: string }; res: void }

  'agents:listAvailable': { req: void; res: AgentAvailability[] }

  'history:search': {
    req: { query: string; sessionId?: string; projectRoot?: string; limit?: number }
    res: HistoryEntry[]
  }

  'settings:get': { req: { key: string }; res: unknown }
  'settings:set': { req: { key: string; value: unknown }; res: void }

  'dialog:pickDirectory': { req: void; res: { path: string } | null }
}

/** Fire-and-forget renderer -> main messages (hot path, no promise overhead). */
export interface Sendables {
  'terminal:input': { sessionId: string; data: string }
  /** Flow-control credit: bytes the renderer's xterm has finished parsing. */
  'terminal:ack': { sessionId: string; bytes: number }
  /** Completed command block captured by the shell-integration pipeline. */
  'history:append': Omit<HistoryEntry, 'id'>
}

/** Push events main -> renderer. */
export interface MainEvents {
  'terminal:data': { sessionId: string; data: Uint8Array }
  'terminal:exit': { sessionId: string; exitCode: number; signal?: number }
  'app:event': AppEvent
}

export type InvokeChannel = keyof Invokables
export type SendChannel = keyof Sendables
export type EventChannel = keyof MainEvents
