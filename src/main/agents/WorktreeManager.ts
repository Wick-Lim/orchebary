import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { Project, Task, TaskRun } from '../../shared/domain'
import type { GitService } from './GitService'

function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 6).toLowerCase() || 'x'
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '')
  return slug || 'task'
}

/**
 * Allocates one git worktree + branch per task run under a fixed root
 * directory. Free of electron imports (root is constructor-injected) so it
 * runs under plain vitest.
 */
export class WorktreeManager {
  constructor(
    private root: string,
    private git: GitService
  ) {}

  pathFor(projectId: string, taskId: string, title: string): string {
    return path.join(this.root, shortId(projectId), `${shortId(taskId)}-${slugify(title)}`)
  }

  branchFor(taskId: string, title: string): string {
    return `orc/${shortId(taskId)}-${slugify(title)}`
  }

  async create(
    project: Project,
    task: Task
  ): Promise<{ worktreePath: string; branch: string; baseRef: string }> {
    const baseRef = await this.git.revParse(project.repoPath, project.baseBranch)
    const basePath = this.pathFor(project.id, task.id, task.title)
    const baseBranch = this.branchFor(task.id, task.title)
    await mkdir(path.dirname(basePath), { recursive: true })
    // Re-runs of the same task get a numeric suffix instead of colliding with
    // a leftover worktree/branch from an earlier run.
    for (let n = 1; n <= 100; n++) {
      const suffix = n === 1 ? '' : `-${n}`
      const worktreePath = basePath + suffix
      const branch = baseBranch + suffix
      if (existsSync(worktreePath) || (await this.branchExists(project.repoPath, branch))) {
        continue
      }
      await this.git.worktreeAdd(project.repoPath, worktreePath, branch, baseRef)
      return { worktreePath, branch, baseRef }
    }
    throw new Error(`unable to allocate a worktree for task ${task.id}`)
  }

  async remove(
    project: Project,
    run: TaskRun,
    opts: { force?: boolean; deleteBranch?: boolean } = {}
  ): Promise<void> {
    if (existsSync(run.worktreePath)) {
      await this.git.worktreeRemove(project.repoPath, run.worktreePath, opts.force ?? false)
    } else {
      await this.git.worktreePrune(project.repoPath)
    }
    if (opts.deleteBranch) {
      try {
        // -D always: squash merges never register as merged for `-d`.
        await this.git.deleteBranch(project.repoPath, run.branch, true)
      } catch {
        // branch already gone — removal is best-effort cleanup
      }
    }
  }

  /**
   * Startup pass: drop git's bookkeeping for worktree dirs that vanished.
   * Worktrees of orphaned runs are intentionally kept — they may still hold
   * reviewable work.
   */
  async reconcile(projects: Project[], activeRunsMarkedDead: TaskRun[]): Promise<void> {
    void activeRunsMarkedDead // kept for review even when their run died
    for (const project of projects) {
      try {
        await this.git.worktreePrune(project.repoPath)
      } catch (err) {
        console.error(`[agents] worktree prune failed for ${project.repoPath}:`, err)
      }
    }
  }

  private async branchExists(repo: string, branch: string): Promise<boolean> {
    try {
      await this.git.revParse(repo, `refs/heads/${branch}`)
      return true
    } catch {
      return false
    }
  }
}
