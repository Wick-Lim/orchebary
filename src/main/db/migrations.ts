export interface Migration {
  version: number
  name: string
  sql: string
}

// Forward-only migrations. Never edit a shipped migration — add a new one.
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  repo_path     TEXT NOT NULL UNIQUE,
  base_branch   TEXT NOT NULL DEFAULT 'main',
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  archived_at   TEXT
);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'todo'
               CHECK (status IN ('todo','inprogress','inreview','done','cancelled')),
  position     TEXT NOT NULL,
  rev          INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX idx_tasks_board ON tasks(project_id, status, position) WHERE deleted_at IS NULL;

CREATE TABLE task_runs (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  agent_kind       TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  parent_run_id    TEXT REFERENCES task_runs(id),
  agent_session_id TEXT,
  worktree_path    TEXT NOT NULL,
  branch           TEXT NOT NULL,
  base_ref         TEXT NOT NULL,
  pid              INTEGER,
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','running','completed','failed','cancelled')),
  exit_code        INTEGER,
  started_at       TEXT,
  finished_at      TEXT,
  summary          TEXT,
  cost_usd         REAL,
  num_turns        INTEGER,
  log_path         TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_runs_task ON task_runs(task_id, created_at);
CREATE INDEX idx_runs_active ON task_runs(status) WHERE status IN ('queued','running');

-- Jira-ready from day one (sync engine itself is phase 2).
CREATE TABLE remote_links (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  provider          TEXT NOT NULL DEFAULT 'jira',
  remote_key        TEXT NOT NULL,
  remote_id         TEXT,
  remote_status     TEXT,
  remote_updated_at TEXT,
  last_pushed_at    TEXT,
  push_pending      INTEGER NOT NULL DEFAULT 0,
  sync_error        TEXT,
  UNIQUE (provider, remote_key)
);

CREATE TABLE jira_status_map (
  project_id    TEXT NOT NULL REFERENCES projects(id),
  jira_status   TEXT NOT NULL,
  local_status  TEXT NOT NULL,
  transition_id TEXT,
  PRIMARY KEY (project_id, jira_status)
);

-- Source of truth: the renderer's block pipeline (OSC 133 command finished).
CREATE TABLE command_history (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  cwd          TEXT NOT NULL,
  command      TEXT NOT NULL,
  exit_code    INTEGER,
  started_at   TEXT NOT NULL,
  duration_ms  INTEGER,
  project_root TEXT
);
CREATE INDEX idx_history_time ON command_history(started_at DESC);
CREATE INDEX idx_history_command ON command_history(command);

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`
  }
]
