// Launch one headless CLI process and collect what it printed. Every agent of a
// review is one of these.
//
// - stdin is never left open: Codex waits forever on an open stdin.
// - Each child is its own process group, so a timeout kills the whole tree,
//   and `killAll` can stop every live agent on SIGINT.
// - A bin ending in .mjs/.js runs under this Node: that is how the tests swap
//   in a fake CLI.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export const BUNDLED_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex'
const live = new Set()

/** The first `name` on PATH, or null. */
export function onPath(name, env = process.env) {
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, name))) return path.join(dir, name)
  }
  return null
}

/** The executable for an agent: an `ADV_REVIEW_<AGENT>_BIN` override, else the CLI's name. */
export function resolveBin(agent, env = process.env) {
  const override = env[`ADV_REVIEW_${String(agent).toUpperCase()}_BIN`]
  if (override) return override
  if (agent === 'codex') return onPath('codex', env) ?? (existsSync(BUNDLED_CODEX) ? BUNDLED_CODEX : 'codex')
  return agent
}

const signalGroup = (child, sig) => {
  try {
    if (process.platform === 'win32' || !child.pid) child.kill(sig)
    else process.kill(-child.pid, sig)
  } catch {}
}

/**
 * Run `bin args` in `cwd` and resolve with `{ code, signal, stdout, stderr,
 * timedOut, durationMs, pid }`. Never rejects: a process that cannot start
 * resolves with `spawnError` set and the message in `stderr`.
 */
export function spawnCli({ bin, args, cwd, env = process.env, timeoutMs = 30 * 60_000, graceMs = 10_000 }) {
  const isScript = /\.m?js$/.test(bin)
  const command = isScript ? process.execPath : bin
  const argv = isScript ? [bin, ...args] : args
  return new Promise((resolve) => {
    const started = Date.now()
    let done = false
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const finish = (code, signal, spawnError = false) => {
      if (done) return
      done = true
      clearTimeout(timer)
      live.delete(child)
      resolve({ code, signal, stdout, stderr, timedOut, durationMs: Date.now() - started, pid: child?.pid ?? null, spawnError })
    }
    let child
    let timer
    try {
      child = spawn(command, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    } catch (err) {
      stderr = String(err?.message ?? err)
      return finish(null, null, true)
    }
    live.add(child)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    timer = setTimeout(() => {
      timedOut = true
      signalGroup(child, 'SIGTERM')
      setTimeout(() => signalGroup(child, 'SIGKILL'), graceMs).unref()
    }, timeoutMs)
    child.on('error', (err) => {
      stderr += `\n${err.message}`
      // A spawn failure (ENOENT) may never emit 'close'.
      setTimeout(() => finish(null, null, true), 0)
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

/** Stop every live child (and its process group). */
export function killAll(sig = 'SIGTERM') {
  for (const child of live) signalGroup(child, sig)
}

export const liveCount = () => live.size
