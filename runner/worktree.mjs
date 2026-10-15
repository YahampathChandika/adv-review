// One disposable git worktree per agent call, created already at the commit
// under review and removed as soon as the call ends. They live under a temp
// root outside the repository, so an editor watching the repository never sees
// them and `git clean` in one cannot reach another.
import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** Run a command and return its stdout; rejects on a non-zero exit. */
export const defaultExec = async (cmd, args, opts = {}) => {
  const { stdout } = await execFileP(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts })
  return stdout
}

/** A label like `find:tests-that-dont-test` as a path segment. */
export const safeName = (label) =>
  String(label ?? 'agent')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'agent'

/**
 * `{ root, add(label) -> { id, dir }, remove(id), removeAll(), prune(), live() }`.
 * With `keep`, worktrees are left in place for inspection.
 */
export async function createWorktrees({ repo, headSha, root, keep = false, exec = defaultExec }) {
  await mkdir(root, { recursive: true })
  const git = (...args) => exec('git', ['-C', repo, ...args])
  const live = new Map()
  let seq = 0
  const api = {
    root,
    async add(label) {
      const id = ++seq
      const dir = path.join(root, `${id}-${safeName(label)}`)
      await git('worktree', 'add', '--detach', '-q', dir, headSha)
      live.set(id, dir)
      return { id, dir }
    },
    async remove(id) {
      const dir = live.get(id)
      if (!dir) return
      live.delete(id)
      if (keep) return
      try {
        await git('worktree', 'remove', '--force', dir)
      } catch {
        try {
          await git('worktree', 'unlock', dir)
        } catch {}
        try {
          await git('worktree', 'remove', '--force', '--force', dir)
        } catch {
          await rm(dir, { recursive: true, force: true })
        }
      }
    },
    async removeAll() {
      for (const id of [...live.keys()]) await api.remove(id)
    },
    async prune() {
      try {
        await git('worktree', 'prune')
      } catch {}
    },
    live: () => live.size,
  }
  return api
}
