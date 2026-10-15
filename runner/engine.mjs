// The host the review script runs on: `agent()` launches one CLI process in its
// own worktree, validates the answer against the schema the script asked for,
// retries once inside the backend on an invalid answer, and returns the parsed
// object or null; `parallel()` never rejects and keeps order; `phase()` and
// `log()` go to stderr.
//
// Backend retries are invisible to the script, which counts its own retries;
// `stats.calls` records every attempt so the cost of a run is visible.
import { validate } from './schema.mjs'

/** A FIFO limiter: at most `n` of the wrapped functions run at once. */
export function createLimiter(n) {
  const max = Math.max(1, Number(n) || 1)
  let active = 0
  const queue = []
  const next = () => {
    while (active < max && queue.length) {
      active++
      queue.shift()()
    }
  }
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push(() =>
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--
            next()
          }),
      )
      next()
    })
}

const stamp = () => new Date().toISOString().slice(11, 19)
export const stderrLog = (line) => process.stderr.write(`${stamp()} ${line}\n`)
const secs = (ms) => `${Math.round(ms / 1000)}s`

/**
 * `options`: `{ runCode, timeoutMs, addDirs, userModel, maxTurns, budgetUsd,
 * network, permissionMode, effort, tmp }`. `userModel` is the model the user
 * named on the command line, if any: Claude agents take the script's model
 * (which already reflects it), the other CLIs take it only when given.
 */
export function createEngine({ backend, worktrees, limiter, options = {}, log = stderrLog, clock = Date.now }) {
  const stats = {
    calls: [],
    cost: { usd: null, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    models: new Set(),
  }
  const addCost = (cost) => {
    if (!cost) return
    if (typeof cost.usd === 'number') stats.cost.usd = (stats.cost.usd ?? 0) + cost.usd
    for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens']) {
      if (typeof cost[key] === 'number') stats.cost[key] += cost[key]
    }
  }
  const modelFor = (opts) => (backend.name === 'claude' ? (opts.model ?? 'opus') : (options.userModel ?? null))

  const agent = (prompt, opts = {}) =>
    limiter(async () => {
      const label = opts.label ?? 'agent'
      const wt = await worktrees.add(label)
      log(`runner: start ${label}`)
      try {
        let text = prompt
        for (let attempt = 1; attempt <= 2; attempt++) {
          const started = clock()
          const r = await backend.run({
            prompt: text,
            schema: opts.schema,
            model: modelFor(opts),
            cwd: wt.dir,
            addDirs: options.addDirs ?? [],
            runCode: options.runCode !== false,
            timeoutMs: options.timeoutMs,
            env: { ...process.env, ADV_REVIEW_LABEL: label, ADV_REVIEW_ATTEMPT: String(attempt), ADV_REVIEW_AGENT: backend.name },
            maxTurns: options.maxTurns,
            budgetUsd: options.budgetUsd,
            network: options.network === true,
            permissionMode: options.permissionMode,
            effort: options.effort,
            tmp: options.tmp,
            seq: `${wt.id}-${attempt}`,
          })
          const durationMs = clock() - started
          addCost(r.cost)
          if (r.model) stats.models.add(r.model)
          const entry = { label, attempt, durationMs, ok: false, reason: null, cost: r.cost ?? null }
          stats.calls.push(entry)
          if (!r.ok) {
            entry.reason = r.reason ?? 'failed'
            log(`runner: fail ${label} attempt ${attempt} after ${secs(durationMs)}: ${entry.reason}`)
            return null
          }
          const check = opts.schema ? validate(opts.schema, r.parsed) : { ok: r.parsed !== undefined, errors: ['no answer'] }
          if (check.ok) {
            entry.ok = true
            log(`runner: done ${label} in ${secs(durationMs)}${typeof r.cost?.usd === 'number' ? ` $${r.cost.usd.toFixed(2)}` : ''}`)
            return r.parsed
          }
          entry.reason = `invalid answer: ${check.errors.join('; ')}`
          log(`runner: ${label} attempt ${attempt} gave an invalid answer: ${check.errors.slice(0, 3).join('; ')}`)
          if (attempt === 1) {
            text = `${prompt}\n\nYour previous answer was invalid: ${check.errors.join('; ')}. Answer again with only a JSON object that matches the schema.`
            continue
          }
          return null
        }
        return null
      } finally {
        await worktrees.remove(wt.id)
      }
    })

  // Like the runtime: never rejects, keeps thunk order, hands back copies.
  const parallel = (thunks) =>
    Promise.all(
      thunks.map((t) =>
        Promise.resolve()
          .then(t)
          .then((v) => (v === undefined ? null : structuredClone(v)))
          .catch(() => null),
      ),
    )

  const phase = (title) => log(`phase: ${title}`)
  const scriptLog = (message) => log(`script: ${message}`)
  return { agent, parallel, phase, log: scriptLog, stats }
}
