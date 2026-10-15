// Claude Code's CLI as a review agent: `claude -p` with the answer enforced by
// `--json-schema`. Works with a Claude subscription sign-in (`--bare` would not).
import os from 'node:os'
import { resolveBin, spawnCli } from '../spawn.mjs'
import { lastJsonObject, extractJson, tail } from './common.mjs'

export const name = 'claude'
export const defaultJobs = Math.max(2, Math.min(6, os.cpus().length - 2))

const RUN_TOOLS = 'Bash,Read,Edit,Write,MultiEdit,NotebookEdit,Glob,Grep'
const READ_TOOLS = 'Bash,Read,Glob,Grep'
// Read-only mode still needs git for the checkout and `rev-parse` every agent runs.
const GIT_ALLOWS = ['checkout', 'rev-parse', 'status', 'log', 'diff', 'show', 'grep', 'ls-files', 'blame'].map((c) => `Bash(git ${c} *)`)

export async function version(env = process.env) {
  const r = await spawnCli({ bin: resolveBin('claude', env), args: ['--version'], env, timeoutMs: 20_000 })
  return r.stdout.trim() || null
}

/** The command for one call, with no side effects: `{ bin, args, env }`. */
export function commandFor({ prompt, schema, model, addDirs = [], runCode = true, maxTurns, budgetUsd, effort, permissionMode, env = process.env }) {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    '--model',
    model ?? 'opus',
    '--no-session-persistence',
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--max-turns',
    String(maxTurns ?? 250),
  ]
  if (typeof budgetUsd === 'number') args.push('--max-budget-usd', String(budgetUsd))
  if (effort) args.push('--effort', effort)
  if (runCode) {
    if (permissionMode === 'auto') args.push('--permission-mode', 'auto', '--permission-prompts', 'none', '--tools', RUN_TOOLS)
    else args.push('--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--tools', RUN_TOOLS)
  } else {
    args.push('--restricted', '--tools', READ_TOOLS, '--permission-mode', 'dontAsk', '--permission-prompts', 'none')
  }
  // Variadic flags go last, each value list ended by the next flag or the end.
  for (const dir of addDirs) args.push('--add-dir', dir)
  if (runCode) {
    if (permissionMode !== 'auto') args.push('--allowedTools', 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit')
  } else {
    args.push('--allowedTools', ...GIT_ALLOWS)
  }
  return { bin: resolveBin('claude', env), args, env: {} }
}

const tokensOf = (modelUsage) => {
  const totals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
  for (const usage of Object.values(modelUsage ?? {})) {
    totals.inputTokens += Number(usage?.inputTokens ?? 0)
    totals.cachedInputTokens += Number(usage?.cacheReadInputTokens ?? 0)
    totals.outputTokens += Number(usage?.outputTokens ?? 0)
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
  const cost = { usd: typeof doc.total_cost_usd === 'number' ? doc.total_cost_usd : null, turns: doc.num_turns ?? null, durationMs: doc.duration_ms ?? null, ...tokensOf(doc.modelUsage) }
  const model = doc.modelUsage ? Object.keys(doc.modelUsage)[0] ?? null : null
  if (doc.is_error || (doc.subtype && doc.subtype !== 'success')) {
    return { ok: false, reason: `${doc.subtype ?? 'error'}${doc.result ? `: ${tail(doc.result, 200)}` : ''}`, cost, model, raw: r }
  }
  const parsed = doc.structured_output ?? extractJson(typeof doc.result === 'string' ? doc.result : '')
  return { ok: true, parsed, text: doc.result ?? '', cost, model, raw: r }
}
