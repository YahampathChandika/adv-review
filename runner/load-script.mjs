// Load the review workflow script the way the Workflow runtime runs it: as the
// body of an async function handed `args`, `agent`, `parallel`, `pipeline`,
// `phase` and `log`. The same mechanism the script's own tests use.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workflows', 'adversarial.js')

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor

/**
 * `{ meta, run(args, host) }`. `host` supplies `agent(prompt, opts)`,
 * `parallel(thunks)`, `phase(title)` and `log(message)`; `pipeline` is not used
 * by the script and is passed as undefined.
 */
export function loadWorkflow(scriptPath = DEFAULT_SCRIPT) {
  const source = readFileSync(scriptPath, 'utf8')
  const metaMatch = source.match(/^export const meta = (\{[\s\S]*?\n\})/m)
  // The meta block is a pure literal by the runtime's rules, so it evaluates alone.
  const meta = metaMatch ? new Function(`return (${metaMatch[1]})`)() : null
  const body = source.replace(/^export const meta =/m, 'const meta =')
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', body)
  return {
    meta,
    path: scriptPath,
    run: (args, host) => fn(args, host.agent, host.parallel, undefined, host.phase, host.log),
  }
}
