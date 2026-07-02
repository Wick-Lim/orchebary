// Domain types shared by main, preload, and renderer.
// This module must stay free of runtime imports (types/constants only).

export type TaskStatus = 'todo' | 'inprogress' | 'inreview' | 'done' | 'cancelled'
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type AgentKind = 'claude-code' | 'gemini-cli' | 'codex'

export const TASK_STATUSES: TaskStatus[] = ['todo', 'inprogress', 'inreview', 'done', 'cancelled']

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To Do',
  inprogress: 'In Progress',
  inreview: 'In Review',
  done: 'Done',
  cancelled: 'Cancelled'
}

export interface ProjectSettings {
  defaultAgent: AgentKind
  /** Optional shell command run inside a fresh worktree before the agent starts. */
  setupScript?: string
}

export interface Project {
  id: string
  name: string
  repoPath: string
  baseBranch: string
  settings: ProjectSettings
  createdAt: string
  updatedAt: string
  archivedAt?: string
}

export interface TaskRunSummary {
  id: string
  agentKind: AgentKind
  status: RunStatus
  branch: string
  startedAt?: string
  finishedAt?: string
  summary?: string
}

export interface RemoteLinkView {
  provider: 'jira'
  remoteKey: string
  remoteStatus?: string
  syncError?: string
}

export interface Task {
  id: string
  projectId: string
  title: string
  description: string
  status: TaskStatus
  /** Fractional-indexing key; ordering within a (project, status) column. */
  position: string
  createdAt: string
  updatedAt: string
  deletedAt?: string
  // Denormalized for card rendering (joined in list queries):
  latestRun?: TaskRunSummary
  remoteLink?: RemoteLinkView
  diffStat?: DiffStat
}

export interface TaskRun {
  id: string
  taskId: string
  agentKind: AgentKind
  prompt: string
  parentRunId?: string
  agentSessionId?: string
  worktreePath: string
  branch: string
  baseRef: string
  pid?: number
  status: RunStatus
  exitCode?: number
  startedAt?: string
  finishedAt?: string
  summary?: string
  costUsd?: number
  numTurns?: number
  logPath?: string
  createdAt: string
}

export interface DiffStat {
  filesChanged: number
  additions: number
  deletions: number
}

export interface FileDiff {
  path: string
  oldPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  /** Unified diff text for this file. */
  patch: string
}

/** Structured event parsed from an agent's output stream (NDJSON for Claude Code). */
export interface AgentEvent {
  at: string
  kind: 'system' | 'assistant-text' | 'tool-use' | 'tool-result' | 'result' | 'raw'
  text?: string
  toolName?: string
  result?: {
    ok: boolean
    summary: string
    sessionId?: string
    costUsd?: number
    numTurns?: number
  }
}

export interface AgentAvailability {
  kind: AgentKind
  displayName: string
  available: boolean
  version?: string
  problem?: string
}

/** One managed git worktree, as shown in the Worktrees view. */
export interface WorktreeEntry {
  worktreePath: string
  /** Ghost: a directory on disk with no known run behind it. */
  orphan: boolean
  branch?: string
  projectId?: string
  projectName?: string
  taskId?: string
  taskTitle?: string
  taskStatus?: TaskStatus
  latestRunId?: string
  latestRunStatus?: RunStatus
  /** Uncommitted changes present in the worktree. */
  dirty?: boolean
}

// ---------------------------------------------------------------------------
// Terminal

export type TerminalKind = 'shell' | 'agent'

export interface TerminalSessionInfo {
  sessionId: string
  kind: TerminalKind
  title: string
  cwd: string
  pid: number
  cols: number
  rows: number
  /** Set for agent-attached sessions. */
  runId?: string
  taskId?: string
  /** The project this terminal works for (one agent terminal per project). */
  projectId?: string
}

export interface CreateTerminalRequest {
  cwd?: string
  cols: number
  rows: number
  /** Optional env overrides merged over the captured login-shell env. */
  env?: Record<string, string>
}

export interface HistoryEntry {
  id: string
  sessionId: string
  cwd: string
  command: string
  exitCode?: number
  startedAt: string
  durationMs?: number
  projectRoot?: string
}

// ---------------------------------------------------------------------------
// Live events pushed main -> renderer (single 'app:event' channel)

export type AppEvent =
  | { type: 'task.updated'; task: Task }
  | { type: 'task.deleted'; taskId: string }
  | { type: 'task.moved'; taskId: string; status: TaskStatus; position: string; rev: number }
  | { type: 'run.status'; run: TaskRun }
  | { type: 'run.output'; runId: string; taskId: string; events: AgentEvent[] }
  | { type: 'run.diffstat'; runId: string; taskId: string; stat: DiffStat }
  | { type: 'terminal.registered'; session: TerminalSessionInfo }
  | { type: 'terminal.closed'; sessionId: string }
  | {
      type: 'jira.syncState'
      projectId: string
      state: 'idle' | 'syncing' | 'error'
      error?: string
    }
