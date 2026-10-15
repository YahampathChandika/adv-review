// Google's Gemini CLI as a review agent: `gemini -p` with the answer asked for
// in the prompt and checked by the runner, since the CLI enforces no schema.
// Experimental, and not yet run against a real Gemini CLI: its flags come from
// the published CLI reference.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { resolveBin, spawnCli } from '../spawn.mjs'
import { extractJson, lastJsonObject, schemaNote, tail } from './common.mjs'

export const name = 'gemini'
export const defaultJobs = 3

export async function version(env = process.env) {
  const r = await spawnCli({ bin: resolveBin('gemini', env), args: ['--version'], env, timeoutMs: 20_000 })
  return r.stdout.trim() || null
}

/**
 * Gemini honours a workspace's own `.gemini/settings.json`, which could lift
 * confirmations for the code under review. The review refuses such a repository
 * unless told otherwise.
 */
export const workspaceConfigPresent = (repo) => ['.gemini', '.agents'].some((d) => existsSync(path.join(repo, d)))

/** The command for one call, with no side effects: `{ bin, args, env }`. */
export function commandFor({ prompt, schema, model, addDirs = [], runCode = true, env = process.env }) {
  const args = ['-p', `${prompt}\n\n${schemaNote(schema)}`, '--output-format', 'json']
  if (model) args.push('-m', model)
  if (runCode) args.push('--approval-mode', 'yolo')
  else args.push('--approval-mode', 'default', '--allowed-tools', 'run_shell_command(git)')
  for (const dir of addDirs) args.push('--include-directories', dir)
  return { bin: resolveBin('gemini', env), args, env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' } }
}

const tokensOf = (stats) => {
  const totals = { usd: null, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
  for (const m of Object.values(stats?.models ?? {})) {
    totals.inputTokens += Number(m?.tokens?.input ?? m?.tokens?.prompt ?? 0)
    totals.cachedInputTokens += Number(m?.tokens?.cached ?? 0)
    totals.outputTokens += Number(m?.tokens?.output ?? m?.tokens?.candidates ?? 0)
  }
  return totals
}

/** `{ ok, parsed, text, cost, model, reason, raw }`. */
export async function run(opts) {
  const { bin, args, env } = commandFor(opts)
  const r = await spawnCli({ bin, args, cwd: opts.cwd, env: { ...opts.env, ...env }, timeoutMs: opts.timeoutMs })
  if (r.timedOut) return { ok: false, reason: `timed out after ${Math.round((opts.timeoutMs ?? 0) / 60_000)} min`, raw: r }
  const doc = lastJsonObject(r.stdout)
  if (!doc) return { ok: false, reason: `no result JSON (exit ${r.code}): ${tail(r.stderr || r.stdout)}`, raw: r }
  const cost = tokensOf(doc.stats)
  const model = Object.keys(doc.stats?.models ?? {})[0] ?? null
  if (r.code !== 0 || doc.error) return { ok: false, reason: `${doc.error?.message ?? doc.error?.type ?? `exit ${r.code}`}`, cost, model, raw: r }
  const text = typeof doc.response === 'string' ? doc.response : ''
  return { ok: true, parsed: extractJson(text), text, cost, model, raw: r }
}
