import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DiffStat, FileDiff } from '../../shared/domain'

const execFileAsync = promisify(execFile)

// Diffs of large runs can be big; keep headroom well above the 1MB default.
const MAX_BUFFER = 64 * 1024 * 1024

export type MergeResult = { ok: true } | { ok: false; conflict: boolean; detail: string }

interface NumstatEntry {
  additions: number
  deletions: number
  oldPath?: string
}

function gitErrorDetail(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string }
  const combined = [e.stderr, e.stdout].filter(Boolean).join('\n').trim()
  return combined || e.message || String(err)
}

function countPrefixed(patch: string, ch: '+' | '-'): number {
  let n = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith(ch) && !line.startsWith(ch.repeat(3))) n++
  }
  return n
}

/**
 * Thin async wrapper over the git CLI. Free of electron imports so it runs
 * under plain vitest; every command is executed with an explicit cwd.
 */
export class GitService {
  private async git(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8'
    })
    return stdout
  }

  async isGitRepo(path: string): Promise<boolean> {
    try {
      const out = await this.git(['rev-parse', '--is-inside-work-tree'], path)
      return out.trim() === 'true'
    } catch {
      return false
    }
  }

  async revParse(repo: string, ref: string): Promise<string> {
    return (await this.git(['rev-parse', ref], repo)).trim()
  }

  async currentBranch(repo: string): Promise<string> {
    return (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).trim()
  }

  /** Empty string means a clean tree. */
  async statusPorcelain(dir: string): Promise<string> {
    return (await this.git(['status', '--porcelain'], dir)).trim()
  }

  async worktreeAdd(repo: string, wtPath: string, branch: string, baseRef: string): Promise<void> {
    await this.git(['worktree', 'add', wtPath, '-b', branch, baseRef], repo)
  }

  async worktreeRemove(repo: string, wtPath: string, force = false): Promise<void> {
    const args = ['worktree', 'remove']
    if (force) args.push('--force')
    args.push(wtPath)
    await this.git(args, repo)
  }

  async worktreePrune(repo: string): Promise<void> {
    await this.git(['worktree', 'prune'], repo)
  }

  async listWorktrees(repo: string): Promise<string[]> {
    const out = await this.git(['worktree', 'list', '--porcelain'], repo)
    return out
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim())
  }

  async deleteBranch(repo: string, branch: string, force = false): Promise<void> {
    await this.git(['branch', force ? '-D' : '-d', branch], repo)
  }

  /** Stage everything and commit. Returns false when there is nothing to commit. */
  async addAllAndCommit(dir: string, message: string): Promise<boolean> {
    await this.git(['add', '-A'], dir)
    if ((await this.statusPorcelain(dir)) === '') return false
    await this.git(['commit', '-m', message], dir)
    return true
  }

  async diffStat(dir: string, baseRef: string): Promise<DiffStat> {
    const entries = this.parseNumstat(await this.git(['diff', '--numstat', '-M', baseRef], dir))
    let additions = 0
    let deletions = 0
    for (const e of entries.values()) {
      additions += e.additions
      deletions += e.deletions
    }
    return { filesChanged: entries.size, additions, deletions }
  }

  async diffFiles(dir: string, baseRef: string): Promise<FileDiff[]> {
    const numstat = this.parseNumstat(await this.git(['diff', '--numstat', '-M', baseRef], dir))
    const raw = await this.git(['diff', '-M', baseRef], dir)
    const files: FileDiff[] = []
    // Patch bodies always prefix content lines (' ', '+', '-'), so a column-0
    // 'diff --git ' can only be a file header.
    const chunks = raw.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '))
    for (const patch of chunks) {
      const status: FileDiff['status'] = /^new file mode /m.test(patch)
        ? 'added'
        : /^deleted file mode /m.test(patch)
          ? 'deleted'
          : /^rename from /m.test(patch)
            ? 'renamed'
            : 'modified'

      let filePath: string | undefined
      let oldPath: string | undefined
      const renameTo = patch.match(/^rename to (.+)$/m)
      if (renameTo) {
        filePath = renameTo[1]
        oldPath = patch.match(/^rename from (.+)$/m)?.[1]
      }
      if (!filePath) {
        filePath = patch.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? patch.match(/^--- a\/(.+)$/m)?.[1]
      }
      if (!filePath) {
        // Binary files carry no ---/+++ lines; fall back to the header.
        const header = patch.slice(0, Math.max(patch.indexOf('\n'), 0))
        const idx = header.lastIndexOf(' b/')
        if (idx >= 0) filePath = header.slice(idx + 3)
      }
      if (!filePath) continue

      const stat = numstat.get(filePath)
      files.push({
        path: filePath,
        oldPath: oldPath ?? stat?.oldPath,
        status,
        additions: stat?.additions ?? countPrefixed(patch, '+'),
        deletions: stat?.deletions ?? countPrefixed(patch, '-'),
        patch
      })
    }
    return files
  }

  /**
   * Squash-merge `branch` into `baseBranch` of `repo`. Preflight requires a
   * clean tree checked out on the base branch; a conflicted merge is rolled
   * back with `git reset --merge`.
   */
  async mergeSquash(
    repo: string,
    baseBranch: string,
    branch: string,
    message?: string
  ): Promise<MergeResult> {
    const status = await this.statusPorcelain(repo)
    if (status !== '') {
      return {
        ok: false,
        conflict: false,
        detail: 'repository has uncommitted changes; commit or stash them first'
      }
    }
    const current = await this.currentBranch(repo)
    if (current !== baseBranch) {
      return {
        ok: false,
        conflict: false,
        detail: `repository is on '${current}', expected base branch '${baseBranch}'`
      }
    }
    try {
      await this.git(['merge', '--squash', branch], repo)
    } catch (err) {
      const detail = gitErrorDetail(err)
      try {
        await this.git(['reset', '--merge'], repo)
      } catch {
        // nothing staged to roll back
      }
      return { ok: false, conflict: /conflict/i.test(detail), detail }
    }
    // A branch with no effective changes leaves nothing staged: still a success.
    if ((await this.statusPorcelain(repo)) === '') return { ok: true }
    await this.git(['commit', '-m', message ?? `orchebary: squash merge ${branch}`], repo)
    return { ok: true }
  }

  private parseNumstat(out: string): Map<string, NumstatEntry> {
    const map = new Map<string, NumstatEntry>()
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      if (parts.length < 3) continue
      // Binary files report '-' for both counts.
      const additions = parts[0] === '-' ? 0 : Number.parseInt(parts[0], 10) || 0
      const deletions = parts[1] === '-' ? 0 : Number.parseInt(parts[1], 10) || 0
      let p = parts.slice(2).join('\t')
      let oldPath: string | undefined
      // Renames come as 'pre{old => new}post' or plain 'old => new'.
      const brace = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/)
      if (brace) {
        oldPath = `${brace[1]}${brace[2]}${brace[4]}`.replace('//', '/')
        p = `${brace[1]}${brace[3]}${brace[4]}`.replace('//', '/')
      } else if (p.includes(' => ')) {
        const [o, n] = p.split(' => ')
        oldPath = o
        p = n
      }
      map.set(p, { additions, deletions, oldPath })
    }
    return map
  }
}
