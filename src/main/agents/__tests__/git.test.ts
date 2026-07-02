import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitService } from '../GitService'

const execFileAsync = promisify(execFile)

async function sh(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

describe('GitService', () => {
  const git = new GitService()
  let dir: string
  let repo: string
  let baseRef: string
  const wt = (): string => path.join(dir, 'wt-feature')
  const branch = 'orc/abc123-feature'

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'orb-git-'))
    repo = path.join(dir, 'repo')
    await mkdir(repo)
    await sh(['init', '-b', 'main'], repo)
    await sh(['config', 'user.email', 'test@orchebary.dev'], repo)
    await sh(['config', 'user.name', 'Orchebary Test'], repo)
    await sh(['config', 'commit.gpgsign', 'false'], repo)
    await writeFile(path.join(repo, 'readme.md'), '# fixture\n')
    await sh(['add', '-A'], repo)
    await sh(['commit', '-m', 'init'], repo)
    baseRef = await git.revParse(repo, 'main')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('detects git repos', async () => {
    expect(await git.isGitRepo(repo)).toBe(true)
    expect(await git.isGitRepo(dir)).toBe(false)
  })

  it('revParse resolves a ref to a sha', async () => {
    expect(baseRef).toMatch(/^[0-9a-f]{40}$/)
    expect(await git.revParse(repo, 'HEAD')).toBe(baseRef)
  })

  it('worktreeAdd creates the directory on a new branch', async () => {
    await git.worktreeAdd(repo, wt(), branch, baseRef)
    expect(existsSync(wt())).toBe(true)
    expect(await git.currentBranch(wt())).toBe(branch)
    // macOS tmpdir mixes /var and /private/var: compare realpaths.
    const listed = await Promise.all((await git.listWorktrees(repo)).map((p) => realpath(p)))
    expect(listed).toContain(await realpath(wt()))
  })

  it('statusPorcelain detects a new file in the worktree', async () => {
    await writeFile(path.join(wt(), 'hello.txt'), 'one\ntwo\nthree\n')
    const status = await git.statusPorcelain(wt())
    expect(status).toContain('hello.txt')
  })

  it('addAllAndCommit commits it and reports nothing on a clean tree', async () => {
    expect(await git.addAllAndCommit(wt(), 'orchebary: add hello')).toBe(true)
    expect(await git.statusPorcelain(wt())).toBe('')
    expect(await git.addAllAndCommit(wt(), 'noop')).toBe(false)
  })

  it('diffStat vs baseRef counts the committed file', async () => {
    expect(await git.diffStat(wt(), baseRef)).toEqual({
      filesChanged: 1,
      additions: 3,
      deletions: 0
    })
  })

  it('diffFiles parses the unified diff into per-file entries', async () => {
    const files = await git.diffFiles(wt(), baseRef)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({
      path: 'hello.txt',
      status: 'added',
      additions: 3,
      deletions: 0
    })
    expect(files[0].patch).toContain('+one')
  })

  it('mergeSquash preflight rejects a dirty base repo', async () => {
    await writeFile(path.join(repo, 'junk.txt'), 'dirty\n')
    const res = await git.mergeSquash(repo, 'main', branch)
    expect(res).toMatchObject({ ok: false, conflict: false })
    await rm(path.join(repo, 'junk.txt'))
  })

  it('mergeSquash merges the branch into main', async () => {
    const res = await git.mergeSquash(repo, 'main', branch)
    expect(res).toEqual({ ok: true })
    expect(existsSync(path.join(repo, 'hello.txt'))).toBe(true)
    expect(await git.currentBranch(repo)).toBe('main')
    expect(await git.statusPorcelain(repo)).toBe('')
  })

  it('mergeSquash reports a conflict and rolls back', async () => {
    const wt2 = path.join(dir, 'wt-conflict')
    const branch2 = 'orc/def456-conflict'
    const head = await git.revParse(repo, 'main')
    await git.worktreeAdd(repo, wt2, branch2, head)
    await writeFile(path.join(wt2, 'readme.md'), '# branch version\n')
    await git.addAllAndCommit(wt2, 'branch edit')
    await writeFile(path.join(repo, 'readme.md'), '# main version\n')
    await git.addAllAndCommit(repo, 'main edit')

    const res = await git.mergeSquash(repo, 'main', branch2)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.conflict).toBe(true)
      expect(res.detail.length).toBeGreaterThan(0)
    }
    // reset --merge must leave the base repo clean again
    expect(await git.statusPorcelain(repo)).toBe('')
    await git.worktreeRemove(repo, wt2, true)
    await git.deleteBranch(repo, branch2, true)
  })

  it('worktreeRemove cleans up the worktree and deleteBranch the branch', async () => {
    await git.worktreeRemove(repo, wt(), true)
    expect(existsSync(wt())).toBe(false)
    const listed = await git.listWorktrees(repo)
    expect(listed.some((p) => p.endsWith('wt-feature'))).toBe(false)
    await git.deleteBranch(repo, branch, true)
    await expect(git.revParse(repo, `refs/heads/${branch}`)).rejects.toThrow()
  })
})
