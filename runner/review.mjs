#!/usr/bin/env node
// The standalone runner: the adversarial review with each agent launched as a
// headless CLI process (claude, codex, gemini or copilot) in its own git worktree.
// Everything the plugin's session does around the workflow, as code. With
// several agents (`--agent claude:sonnet,codex:gpt-5.5`) it reviews once per
// agent, all at the same time, and prints the comparison.
import { mkdir, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { backendFor } from './backends/index.mjs'
import { workspaceConfigPresent } from './backends/gemini.mjs'
import { CliError, USAGE, parseCli } from './cli.mjs'
import { compare, render } from './compare.mjs'
import { createEngine, createLimiter, stderrLog } from './engine.mjs'
import { loadWorkflow } from './load-script.mjs'
import { buildArgs, preparePr, prepareBranch, readProjectConfig } from './prepare.mjs'
import { postComment, renderComment, renderReport, writeOut } from './report.mjs'
import { killAll } from './spawn.mjs'
import { createWorktrees, defaultExec, safeName } from './worktree.mjs'

export const RUNNER_VERSION = '0.5.4'
const here = path.dirname(fileURLToPath(import.meta.url))

const runId = () => `${Date.now().toString(36)}-${process.pid.toString(36)}`

/** The name of one run in a comparison: the agent, and its model when one was named. */
export const labelFor = ({ agent, model }) => (model ? `${agent}-${safeName(model)}` : agent)

/** With `--out results.json`, a comparison keeps each result as `results.<label>.json`. */
export const outFileFor = (out, label) => {
  const ext = path.extname(out)
  return `${out.slice(0, out.length - ext.length)}.${label}${ext || '.json'}`
}

const describeTarget = (target) => (target.prs ? `PR ${target.prs.map((n) => `#${n}`).join(', ')}` : `branch ${target.branch}`)

/** One review, start to finish: `{ code, result }`. */
async function reviewOne(run, { repo, prepared, exec, log, env, managers }) {
  const { backend, args, options, cli } = run
  const jobs = cli.jobs ?? backend.defaultJobs
  await mkdir(run.tmp, { recursive: true })
  const worktrees = await createWorktrees({ repo, headSha: args.headSha, root: path.join(run.tmp, 'worktrees'), keep: cli.keepWorktrees, exec })
  managers.push(worktrees)
  const engine = createEngine({ backend, worktrees, limiter: createLimiter(jobs), options, log })
  const started = Date.now()
  const cliVersion = await backend.version(env).catch(() => null)
  log(`runner: ${cli.agent}${cliVersion ? ` ${cliVersion}` : ''}, ${jobs} at once, ${describeTarget(prepared.target)} at ${args.headSha.slice(0, 8)}`)
  let result
  try {
    result = await loadWorkflow(path.join(here, '..', 'workflows', 'adversarial.js')).run(args, engine)
  } catch (err) {
    log(`error: the review script stopped: ${err.message}`)
    await worktrees.removeAll()
    await worktrees.prune()
    return { code: 1, result: null }
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
  return { code: 0, result }
}

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
  const repo = (await exec('git', ['rev-parse', '--show-toplevel'], { cwd: cli.repo ?? process.cwd() })).trim()
  if (cli.runs.some((r) => r.agent === 'gemini') && workspaceConfigPresent(repo) && !cli.allowWorkspaceConfig) {
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

  // One run per agent; a comparison gives each its own folder and log prefix.
  const comparing = cli.runs.length > 1
  const runs = cli.runs.map((spec) => {
    const label = labelFor(spec)
    const runCli = { ...cli, agent: spec.agent, model: spec.model }
    const runTmp = comparing ? path.join(tmp, label) : tmp
    return {
      label,
      cli: runCli,
      backend: backendFor(spec.agent),
      args: buildArgs(prepared, runCli, config),
      tmp: runTmp,
      options: {
        runCode: cli.run,
        timeoutMs: cli.timeoutMin * 60_000,
        addDirs: [path.join(tmp, 'diffs')],
        userModel: spec.model,
        maxTurns: cli.maxTurns,
        budgetUsd: cli.budgetUsd,
        network: cli.network,
        permissionMode: cli.claudePermissionMode,
        tmp: runTmp,
      },
      log: comparing ? (line) => log(`[${label}] ${line}`) : log,
    }
  })

  if (cli.dryRun) {
    for (const run of runs) {
      stdout(JSON.stringify({ args: run.args, options: { ...run.options, tmp: undefined } }, null, 2))
      const sample = run.backend.commandFor({ prompt: '<prompt>', schema: { type: 'object' }, schemaFile: '<schema.json>', outFile: '<out.json>', model: run.cli.agent === 'claude' ? (run.args.model ?? 'opus') : run.cli.model, cwd: '<worktree>', addDirs: run.options.addDirs, runCode: cli.run, network: cli.network, permissionMode: cli.claudePermissionMode, maxTurns: cli.maxTurns, budgetUsd: cli.budgetUsd, env })
      stdout(`sample command: ${[sample.bin, ...sample.args.map((a) => (a.length > 60 ? `${a.slice(0, 57)}...` : a))].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)
    }
    await rm(tmp, { recursive: true, force: true })
    return 0
  }

  const managers = []
  const onSignal = (sig) => async () => {
    log(`runner: ${sig} — stopping agents and removing worktrees`)
    killAll()
    for (const w of managers) {
      await w.removeAll()
      await w.prune()
    }
    process.exit(sig === 'SIGINT' ? 130 : 143)
  }
  process.once('SIGINT', onSignal('SIGINT'))
  process.once('SIGTERM', onSignal('SIGTERM'))

  const outcomes = await Promise.all(runs.map((run) => reviewOne(run, { repo, prepared, exec, log: run.log, env, managers })))
  const cleanup = async () => {
    if (!cli.keepWorktrees) await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }

  if (!comparing) {
    const { code, result } = outcomes[0]
    if (code) return code
    if (cli.out) await writeOut(cli.out, result)
    stdout(renderReport(result))
    if (cli.post && result.target?.prs) {
      const pr = result.target.prs[result.target.prs.length - 1]
      await postComment({ pr, body: renderComment(result, { includePreexisting: cli.includePreexisting }), repo, exec })
      log(`runner: comment posted on #${pr}`)
    }
    await cleanup()
    return 0
  }

  // A comparison: keep each result where --out says, then put them side by side.
  const reviews = []
  for (const [i, run] of runs.entries()) {
    const { result } = outcomes[i]
    if (!result) continue
    const file = cli.out ? outFileFor(cli.out, run.label) : path.join(tmp, `${run.label}.json`)
    await writeOut(file, result)
    if (cli.out) log(`runner: ${run.label} result written to ${file}`)
    reviews.push({ name: run.label, result })
  }
  const failed = runs.filter((_, i) => outcomes[i].code)
  if (failed.length) {
    log(`error: ${failed.map((r) => r.label).join(', ')} did not finish; nothing to compare`)
    await cleanup()
    return 1
  }
  stdout(render(compare(reviews)))
  for (const { name, result } of reviews) {
    if (result.status !== 'complete') log(`runner: ${name} came back ${result.status}: ${(result.incomplete ?? []).join('; ')}`)
  }
  await cleanup()
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
