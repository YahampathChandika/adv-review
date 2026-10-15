// GitHub Copilot CLI as a review agent: `copilot -p` in silent mode, with the
// answer asked for in the prompt and checked by the runner, since the CLI
// enforces no schema. Experimental, and not run against a real Copilot CLI:
// its flags come from the published programmatic reference.
//
// Permissions are the CLI's tool allow-list, not an OS sandbox: with code
// allowed to run, every tool is allowed; with `--no-run`, only git shell
// commands, and writes are denied. The worktree is the working directory and
// the diff folder is added to the allowed paths. Project extensions (the
// repository's own agents, skills and MCP servers) stay out of each agent, as
// they do by default in prompt mode.
import { resolveBin, spawnCli } from '../spawn.mjs'
import { extractJson, schemaNote, tail } from './common.mjs'

export const name = 'copilot'
export const defaultJobs = 3

export async function version(env = process.env) {
  const r = await spawnCli({ bin: resolveBin('copilot', env), args: ['--version'], env, timeoutMs: 20_000 })
  return r.stdout.trim() || null
}

/** The model the CLI runs when none is named: `COPILOT_MODEL` if set, else its own default, which it does not report. */
export const defaultModel = (env = process.env) => env.COPILOT_MODEL || null

/** The command for one call, with no side effects: `{ bin, args, env }`. */
export function commandFor({ prompt, schema, model, addDirs = [], runCode = true, env = process.env }) {
  const args = ['-p', `${prompt}\n\n${schemaNote(schema)}`, '-s', '--no-ask-user']
  if (model) args.push(`--model=${model}`)
  if (runCode) args.push('--allow-all-tools')
  else args.push('--allow-tool=shell(git:*)', '--deny-tool=write')
  for (const dir of addDirs) args.push(`--add-dir=${dir}`)
  return { bin: resolveBin('copilot', env), args, env: { GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: 'false', COPILOT_AUTO_UPDATE: 'false' } }
}

/** `{ ok, parsed, text, cost, model, reason, raw }`. Silent mode reports no usage, so `cost` is null. */
export async function run(opts) {
  const { bin, args, env } = commandFor(opts)
  const r = await spawnCli({ bin, args, cwd: opts.cwd, env: { ...opts.env, ...env }, timeoutMs: opts.timeoutMs })
  if (r.timedOut) return { ok: false, reason: `timed out after ${Math.round((opts.timeoutMs ?? 0) / 60_000)} min`, raw: r }
  const model = opts.model ?? defaultModel(opts.env ?? process.env)
  if (r.code !== 0) return { ok: false, reason: `exit ${r.code}: ${tail(r.stderr || r.stdout)}`, cost: null, model, raw: r }
  const text = String(r.stdout ?? '')
  return { ok: true, parsed: extractJson(text), text, cost: null, model, raw: r }
}
