#!/usr/bin/env node
// The standalone runner: the adversarial review with each agent launched as a
// headless CLI process (claude, codex, gemini or copilot) in its own git worktree.
// Everything the plugin's session does around the workflow, as code.
import { mkdir, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { backendFor } from './backends/index.mjs'
import { workspaceConfigPresent } from './backends/gemini.mjs'
import { CliError, USAGE, parseCli } from './cli.mjs'
import { createEngine, createLimiter, stderrLog } from './engine.mjs'
import { loadWorkflow } from './load-script.mjs'
import { buildArgs, preparePr, prepareBranch, readProjectConfig } from './prepare.mjs'
import { postComment, renderComment, renderReport, writeOut } from './report.mjs'
import { killAll } from './spawn.mjs'
import { createWorktrees, defaultExec } from './worktree.mjs'

export const RUNNER_VERSION = '0.5.1'
const here = path.dirname(fileURLToPath(import.meta.url))

const runId = () => `${Date.now().toString(36)}-${process.pid.toString(36)}`

/** The runner, start to finish. Returns the exit code. */
export async function main(argv, { exec = defaultExec, log = stderrLog, stdout = (s) => process.stdout.write(`${s}\n`), env = process.env } = {}) {
  let cli
  try {
    cli = parseCli(argv)
  } catch (err) {
    if (err instanceof CliError) {
      log(`error: ${err.message}`)
      log(USAGE)
      return 2
    }
    throw err
  }
  if (cli.help) {
    stdout(USAGE)
    return 0
  }
  const backend = backendFor(cli.agent)
  const repo = (await exec('git', ['rev-parse', '--show-toplevel'], { cwd: cli.repo ?? process.cwd() })).trim()
  if (cli.agent === 'gemini' && workspaceConfigPresent(repo) && !cli.allowWorkspaceConfig) {
    log('error: this repository carries its own .gemini/ or .agents/ settings, which Gemini would honour inside the review; pass --allow-workspace-config to review it anyway')
    return 2
  }

  const tmp = path.join(await realpath(os.tmpdir()), 'adv-review', runId())
  await mkdir(tmp, { recursive: true })
  const config = await readProjectConfig(repo)
  let prepared
  if (cli.branchMode) {
    prepared = await prepareBranch({ repo, branch: cli.branch, base: cli.base, tmp, exec })
    if (prepared.dirty) log('note: the working tree has uncommitted changes; they are not part of this review')
  } else {
    let prs = cli.prs
    if (!prs.length) {
      try {
        prs = [JSON.parse(await exec('gh', ['pr', 'view', '--json', 'number'], { cwd: repo })).number]
      } catch {
        log('error: no pull request for the current branch; give a number, or use --branch to review the branch itself')
        return 2
      }
    }
    prepared = await preparePr({ repo, prs, stackedOn: cli.stackedOn, tmp, exec })
  }
  const args = buildArgs(prepared, cli, config)
  const options = {
    runCode: cli.run,
    timeoutMs: cli.timeoutMin * 60_000,
    addDirs: [path.join(tmp, 'diffs')],
    userModel: cli.model,
    maxTurns: cli.maxTurns,
    budgetUsd: cli.budgetUsd,
    network: cli.network,
    permissionMode: cli.claudePermissionMode,
    tmp,
  }

  if (cli.dryRun) {
    stdout(JSON.stringify({ args, options: { ...options, tmp: undefined } }, null, 2))
    const sample = backend.commandFor({ prompt: '<prompt>', schema: { type: 'object' }, schemaFile: '<schema.json>', outFile: '<out.json>', model: cli.agent === 'claude' ? (args.model ?? 'opus') : cli.model, cwd: '<worktree>', addDirs: options.addDirs, runCode: cli.run, network: cli.network, permissionMode: cli.claudePermissionMode, maxTurns: cli.maxTurns, budgetUsd: cli.budgetUsd, env })
    stdout(`sample command: ${[sample.bin, ...sample.args.map((a) => (a.length > 60 ? `${a.slice(0, 57)}...` : a))].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)
    await rm(tmp, { recursive: true, force: true })
    return 0
  }

  const jobs = cli.jobs ?? backend.defaultJobs
  const worktrees = await createWorktrees({ repo, headSha: args.headSha, root: path.join(tmp, 'worktrees'), keep: cli.keepWorktrees, exec })
  const engine = createEngine({ backend, worktrees, limiter: createLimiter(jobs), options, log })
  const onSignal = (sig) => async () => {
    log(`runner: ${sig} — stopping agents and removing worktrees`)
    killAll()
    await worktrees.removeAll()
    await worktrees.prune()
    process.exit(sig === 'SIGINT' ? 130 : 143)
  }
  process.once('SIGINT', onSignal('SIGINT'))
  process.once('SIGTERM', onSignal('SIGTERM'))

  const started = Date.now()
  const cliVersion = await backend.version(env).catch(() => null)
  log(`runner: ${cli.agent}${cliVersion ? ` ${cliVersion}` : ''}, ${jobs} at once, ${prepared.target.prs ? `PR ${prepared.target.prs.map((n) => `#${n}`).join(', ')}` : `branch ${prepared.target.branch}`} at ${args.headSha.slice(0, 8)}`)
  let result
  try {
    result = await loadWorkflow(path.join(here, '..', 'workflows', 'adversarial.js')).run(args, engine)
  } catch (err) {
    log(`error: the review script stopped: ${err.message}`)
    await worktrees.removeAll()
    await worktrees.prune()
    return 1
  } finally {
    if (!cli.keepWorktrees) {
      await worktrees.removeAll()
      await worktrees.prune()
    } else log(`runner: worktrees kept under ${worktrees.root}`)
  }
  result.runner = {
    version: RUNNER_VERSION,
    agent: cli.agent,
    model: [...engine.stats.models][0] ?? (cli.agent === 'claude' ? (args.model ?? 'opus') : (cli.model ?? backend.defaultModel?.(env) ?? 'cli-default')),
    cliVersion,
    jobs,
    startedAt: new Date(started).toISOString(),
    elapsedMs: Date.now() - started,
    cost: engine.stats.cost,
    calls: engine.stats.calls,
    intent: prepared.target.prs ? (args.intent ? 'excerpt' : null) : args.intent ? 'commits' : null,
  }
  if (cli.out) await writeOut(cli.out, result)
  stdout(renderReport(result))
  if (cli.post && result.target?.prs) {
    const pr = result.target.prs[result.target.prs.length - 1]
    await postComment({ pr, body: renderComment(result, { includePreexisting: cli.includePreexisting }), repo, exec })
    log(`runner: comment posted on #${pr}`)
  }
  if (!cli.keepWorktrees) await rm(tmp, { recursive: true, force: true }).catch(() => {})
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`error: ${err?.stack ?? err}\n`)
      process.exit(1)
    },
  )
}
