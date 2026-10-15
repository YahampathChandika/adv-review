// The runner's command line. Errors here cost nothing: no agent has run yet.
import { parseArgs } from 'node:util'
import { AGENTS } from './backends/index.mjs'

export const USAGE = `usage: node runner/review.mjs [<pr>...] [--branch [name]] [--base <ref>] [options]

  <pr>...                 pull request number(s); several = a stack, the last on top
  --branch [name]         review a branch (default: the current one) against its base
  --base <ref>            with --branch: what to measure against (default: the remote's default branch)
  --agent <name>          claude (default), codex, gemini or copilot
  --model <name>          the agents' model (Claude: default opus, or the project config's model)
  --agents <N>            the most agents the review may use (default: computed by the script)
  --jobs <N>              how many agents run at once (default: per agent)
  --no-run                agents read the code but execute none of it
  --post                  post the summary comment on the pull request (never for a branch)
  --include-preexisting   include pre-existing findings in the posted comment
  --out <path>            write the full result JSON to this file
  --stacked-on <n>        this PR sits on open PR n, whose code is out of scope
  --repo <path>           the repository (default: the current directory's)
  --timeout <minutes>     give up on one agent after this long (default 30)
  --keep-worktrees        leave the agents' worktrees in place for inspection
  --dry-run               prepare and print the workflow arguments, run nothing
  --network               codex: allow network inside the sandbox
  --max-turns <N>         claude: agentic turns per agent (default 250)
  --budget-usd <X>        claude: dollar cap per agent
  --claude-permission-mode <acceptEdits|auto>   how Claude agents get permissions (default acceptEdits)
  --allow-workspace-config  gemini: review a repository that carries its own .gemini/ settings
  -h, --help
`

const OPTIONS = {
  branch: { type: 'string' },
  base: { type: 'string' },
  agent: { type: 'string', default: 'claude' },
  model: { type: 'string' },
  agents: { type: 'string' },
  jobs: { type: 'string' },
  'no-run': { type: 'boolean', default: false },
  post: { type: 'boolean', default: false },
  'include-preexisting': { type: 'boolean', default: false },
  out: { type: 'string' },
  'stacked-on': { type: 'string' },
  repo: { type: 'string' },
  timeout: { type: 'string', default: '30' },
  'keep-worktrees': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  network: { type: 'boolean', default: false },
  'max-turns': { type: 'string' },
  'budget-usd': { type: 'string' },
  'claude-permission-mode': { type: 'string', default: 'acceptEdits' },
  'allow-workspace-config': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
}

export class CliError extends Error {}

const whole = (name, raw, { min = 1 } = {}) => {
  if (raw === undefined) return null
  const n = Number(String(raw).trim())
  if (!Number.isInteger(n) || n < min) throw new CliError(`--${name} must be a whole number of at least ${min}, got ${JSON.stringify(raw)}`)
  return n
}

/** `--branch` may stand alone (the current branch) or take a name. */
const normalise = (argv) => {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--branch') {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-') && !/^\d+$/.test(next)) {
        out.push(`--branch=${next}`)
        i++
      } else out.push('--branch=')
    } else out.push(a)
  }
  return out
}

/** Parsed, checked options. Throws `CliError` with a message for the user. */
export function parseCli(argv) {
  let parsed
  try {
    parsed = parseArgs({ args: normalise(argv), options: OPTIONS, allowPositionals: true, strict: true })
  } catch (err) {
    throw new CliError(err.message)
  }
  const v = parsed.values
  if (v.help) return { help: true }
  const prs = parsed.positionals.map((p) => {
    const n = Number(p)
    if (!Number.isInteger(n) || n <= 0) throw new CliError(`not a pull request number: ${JSON.stringify(p)}`)
    return n
  })
  const branchMode = v.branch !== undefined
  if (branchMode && prs.length) throw new CliError('give pull request numbers or --branch, not both')
  if (branchMode && v.post) throw new CliError('a branch review has nothing to post to: drop --post or review the pull request')
  if (!AGENTS.includes(v.agent)) throw new CliError(`--agent must be one of ${AGENTS.join(', ')}, got ${JSON.stringify(v.agent)}`)
  if (!['acceptEdits', 'auto'].includes(v['claude-permission-mode'])) throw new CliError('--claude-permission-mode must be acceptEdits or auto')
  const budget = v['budget-usd'] === undefined ? null : Number(v['budget-usd'])
  if (budget !== null && !(budget > 0)) throw new CliError('--budget-usd must be a positive number')
  return {
    help: false,
    prs,
    branch: branchMode ? v.branch || null : undefined,
    branchMode,
    base: v.base ?? null,
    agent: v.agent,
    model: v.model ?? null,
    agents: whole('agents', v.agents, { min: 4 }),
    jobs: whole('jobs', v.jobs),
    run: !v['no-run'],
    post: v.post,
    includePreexisting: v['include-preexisting'],
    out: v.out ?? null,
    stackedOn: whole('stacked-on', v['stacked-on']),
    repo: v.repo ?? null,
    timeoutMin: whole('timeout', v.timeout),
    keepWorktrees: v['keep-worktrees'],
    dryRun: v['dry-run'],
    network: v.network,
    maxTurns: whole('max-turns', v['max-turns']),
    budgetUsd: budget,
    claudePermissionMode: v['claude-permission-mode'],
    allowWorkspaceConfig: v['allow-workspace-config'],
  }
}
