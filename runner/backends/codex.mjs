// OpenAI's Codex CLI as a review agent: `codex exec` with the answer enforced by
// `--output-schema` and read from the `-o` file. Experimental.
//
// Codex sandboxes its own commands, so a review started from inside a Codex
// session would have these agents cut off from the network; run the runner
// from a terminal. The worktree is created at the commit under review because
// the sandbox keeps `.git` read-only.
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveBin, spawnCli } from '../spawn.mjs'
import { extractJson, schemaNote, tail } from './common.mjs'

export const name = 'codex'
export const defaultJobs = 3

/** The `model = "…"` line of a Codex config, or null. */
export const defaultModelFrom = (toml) => String(toml ?? '').match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] ?? null

/** The model the Codex CLI runs by default: its config's `model`, since its events do not name one. */
export function defaultModel(env = process.env) {
  const file = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml')
  try {
    return defaultModelFrom(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export async function version(env = process.env) {
  const r = await spawnCli({ bin: resolveBin('codex', env), args: ['--version'], env, timeoutMs: 20_000 })
  return r.stdout.trim() || null
}

/** The command for one call, with no side effects: `{ bin, args, env }`. */
export function commandFor({ prompt, schema, schemaFile, outFile, model, cwd, runCode = true, network = false, useSchema = true, env = process.env }) {
  const text = useSchema ? prompt : `${prompt}\n\n${schemaNote(schema)}`
  const args = ['exec', text, '--json', '--ephemeral', '--skip-git-repo-check', '-C', cwd, '-o', outFile, '-c', 'approval_policy="never"']
  if (useSchema) args.push('--output-schema', schemaFile)
  if (model) args.push('-m', model)
  if (runCode) {
    args.push('-s', 'workspace-write')
    if (network) args.push('-c', 'sandbox_workspace_write.network_access=true')
  } else {
    args.push('-s', 'read-only')
  }
  return { bin: resolveBin('codex', env), args, env: {} }
}

const events = (stdout) =>
  String(stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)

const usageOf = (evs) => {
  const done = [...evs].reverse().find((e) => e.type === 'turn.completed' && e.usage)
  const u = done?.usage ?? {}
  return { usd: null, inputTokens: Number(u.input_tokens ?? 0), cachedInputTokens: Number(u.cached_input_tokens ?? 0), outputTokens: Number(u.output_tokens ?? 0) }
}

/** `{ ok, parsed, text, cost, model, reason, raw }`. */
export async function run(opts, { useSchema = true } = {}) {
  const dir = path.join(opts.tmp ?? process.cwd(), 'codex')
  await mkdir(dir, { recursive: true })
  const schemaFile = path.join(dir, `${opts.seq ?? 'call'}.schema.json`)
  const outFile = path.join(dir, `${opts.seq ?? 'call'}${useSchema ? '' : '.b'}.out.json`)
  if (useSchema) await writeFile(schemaFile, JSON.stringify(opts.schema))
  const { bin, args, env } = commandFor({ ...opts, schemaFile, outFile, useSchema })
  const r = await spawnCli({ bin, args, cwd: opts.cwd, env: { ...opts.env, ...env }, timeoutMs: opts.timeoutMs })
  if (r.timedOut) return { ok: false, reason: `timed out after ${Math.round((opts.timeoutMs ?? 0) / 60_000)} min`, raw: r }
  const evs = events(r.stdout)
  const cost = usageOf(evs)
  const model = evs.find((e) => e.type === 'thread.started')?.model ?? null
  // A CLI that refuses the schema itself: say so once, then ask for the JSON in the prompt.
  if (r.code !== 0 && useSchema && /schema/i.test(`${r.stderr}\n${r.stdout}`)) {
    return run({ ...opts, prompt: opts.prompt }, { useSchema: false })
  }
  const failed = evs.find((e) => e.type === 'turn.failed' || e.type === 'error')
  if (r.code !== 0 || failed) {
    return { ok: false, reason: `${failed ? `${failed.type}: ${tail(JSON.stringify(failed.error ?? failed.message ?? failed), 200)}` : `exit ${r.code}`}${r.stderr ? ` ${tail(r.stderr, 200)}` : ''}`, cost, model, raw: r }
  }
  let text = ''
  try {
    text = await readFile(outFile, 'utf8')
  } catch {
    const last = [...evs].reverse().find((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')
    text = last?.item?.text ?? ''
  }
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = extractJson(text)
  }
  return { ok: true, parsed, text, cost, model, raw: r }
}
