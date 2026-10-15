// Run with: node --test   (from the repository root)
//
// The standalone runner, with every CLI replaced by tests/fixtures/fake-cli.mjs:
// no model is called. A throwaway git repository stands in for the project.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { score } from '../calibration/lib.mjs'
import * as claude from '../runner/backends/claude.mjs'
import * as codex from '../runner/backends/codex.mjs'
import { extractJson } from '../runner/backends/common.mjs'
import * as copilot from '../runner/backends/copilot.mjs'
import * as gemini from '../runner/backends/gemini.mjs'
import { CliError, parseCli } from '../runner/cli.mjs'
import { createEngine, createLimiter } from '../runner/engine.mjs'
import { loadWorkflow } from '../runner/load-script.mjs'
import { buildArgs, intentFrom } from '../runner/prepare.mjs'
import { main } from '../runner/review.mjs'
import { describe, validate } from '../runner/schema.mjs'
import { liveCount } from '../runner/spawn.mjs'
import { createWorktrees, safeName } from '../runner/worktree.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const FAKE = path.join(here, 'fixtures', 'fake-cli.mjs')
const SKILL = path.join(here, '..', 'skills', 'review', 'SKILL.md')
for (const agent of ['CLAUDE', 'CODEX', 'GEMINI', 'COPILOT']) process.env[`ADV_REVIEW_${agent}_BIN`] = FAKE

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

/** A repository with `main` (one commit) and `feature` (one more): the feature commit is the head under review. */
function tempRepo() {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'adv-runner-'))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(path.join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'one')
  const mainSha = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'checkout', '-q', '-b', 'feature')
  writeFileSync(path.join(repo, 'b.txt'), 'two\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'Add b')
  const headSha = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'checkout', '-q', 'main')
  return { repo, mainSha, headSha }
}

/** Point the fake CLI at a mode, a script of answers and a log, for the duration of `fn`. */
async function withFake({ mode = 'claude', script = null, sleepMs = null } = {}, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'adv-fake-'))
  const log = path.join(dir, 'calls.jsonl')
  const scriptFile = path.join(dir, 'script.json')
  if (script) writeFileSync(scriptFile, JSON.stringify(script))
  const saved = {}
  const set = { ADV_REVIEW_FAKE_MODE: mode, ADV_REVIEW_FAKE_LOG: log, ADV_REVIEW_FAKE_SCRIPT: script ? scriptFile : undefined, ADV_REVIEW_FAKE_SLEEP_MS: sleepMs ? String(sleepMs) : undefined }
  for (const [k, v] of Object.entries(set)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
    return await fn({ dir, log, calls })
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const finding = (over = {}) => ({ title: 'A defect', file: 'src/a.ts', line: 10, category: 'correctness', severity: 'high', summary: 'It is wrong.', failure: 'x -> y', evidence: 'read it', introducedByDiff: true, ...over })

/** The schemas the script hands its agents, collected by running it with a recording host. */
async function collectSchemas() {
  const { repo, headSha } = tempRepo()
  const schemas = {}
  const host = {
    agent: async (prompt, opts) => {
      schemas[opts.label.split(':')[0]] = opts.schema
      const kind = opts.label.split(':')[0]
      const base = { reviewedCommit: headSha }
      if (kind === 'scout') return { ...base, drop: [], add: [] }
      if (kind === 'find') return { ...base, findings: opts.label === 'find:correctness' ? [finding(), finding({ title: 'Another at the same place', category: 'security' })] : [] }
      if (kind === 'triage') return { clusters: [] }
      if (kind === 'same-site') return { ...base, merges: [] }
      if (kind === 'refute') {
        const n = (prompt.match(/^\[\d+\] (CRITICAL|HIGH|MEDIUM|LOW) — /gm) ?? []).length
        return { ...base, verdicts: Array.from({ length: n }, (_, index) => ({ index, refuted: false, confidence: 'certain', reasoning: 'real' })) }
      }
      return { ...base, gaps: [] }
    },
    parallel: (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null))),
    phase: () => {},
    log: () => {},
  }
  await loadWorkflow().run({ prs: [1], diffs: ['/tmp/none.diff'], headSha, agents: 20 }, host)
  await rm(repo, { recursive: true, force: true })
  return { schemas, headSha }
}

async function engineOn({ repo, headSha, backend = claude, jobs = 4, options = {} }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'adv-wt-'))
  const worktrees = await createWorktrees({ repo, headSha, root })
  const logs = []
  const engine = createEngine({ backend, worktrees, limiter: createLimiter(jobs), options: { runCode: true, timeoutMs: 20_000, addDirs: [], tmp: root, ...options }, log: (l) => logs.push(l) })
  return { engine, worktrees, root, logs }
}

// ---------------------------------------------------------------- schema

test('schema: each of the six script schemas accepts a valid document', async () => {
  const { schemas, headSha } = await collectSchemas()
  assert.deepEqual(Object.keys(schemas).sort(), ['critic', 'find', 'refute', 'same-site', 'scout', 'triage'])
  const ok = (s, doc) => assert.deepEqual(validate(s, doc), { ok: true }, JSON.stringify(validate(s, doc)))
  ok(schemas.find, { reviewedCommit: headSha, findings: [finding()] })
  ok(schemas.scout, { reviewedCommit: headSha, drop: [{ title: 'security', why: 'no surface' }], add: [{ title: 'x', brief: 'look here' }], order: ['x'], notes: 'n', baseline: { ran: true, failures: [] } })
  ok(schemas.triage, { clusters: [{ ids: ['F1', 'F2'], rootCause: 'one' }] })
  ok(schemas['same-site'], { reviewedCommit: headSha, merges: [{ ids: ['G1', 'G2'], reason: 'same', rootCause: 'r' }] })
  ok(schemas.refute, { reviewedCommit: headSha, verdicts: [{ index: 0, refuted: true, confidence: 'unsure', reasoning: 'r', falseSites: [1], correctedSeverity: 'low', correctedIntroducedByDiff: false }] })
  ok(schemas.critic, { reviewedCommit: headSha, gaps: [{ what: 'w', why: 'y' }] })
  assert.equal(describe(schemas.triage), '{ clusters: [{ ids: [string], rootCause: string }] }')
})

test('schema: index must be an integer, refuted and introducedByDiff booleans, falseSites integers, severity an enum', async () => {
  const { schemas, headSha } = await collectSchemas()
  const v = validate(schemas.refute, { reviewedCommit: headSha, verdicts: [{ index: '0', refuted: 'false', confidence: 'maybe', reasoning: 'r', falseSites: ['1'] }] })
  assert.equal(v.ok, false)
  assert.ok(v.errors.includes('$.verdicts[0].index: expected integer, got string "0"'), v.errors.join(' | '))
  assert.ok(v.errors.includes('$.verdicts[0].refuted: expected boolean, got string "false"'))
  assert.ok(v.errors.some((e) => e.startsWith('$.verdicts[0].confidence: expected one of "certain", "likely", "unsure"')))
  assert.ok(v.errors.includes('$.verdicts[0].falseSites[0]: expected integer, got string "1"'))
  const f = validate(schemas.find, { reviewedCommit: headSha, findings: [finding({ line: 10.5, introducedByDiff: 'true', severity: 'urgent' })] })
  assert.equal(f.ok, false)
  assert.ok(f.errors.includes('$.findings[0].line: expected integer, got number 10.5'))
  assert.ok(f.errors.includes('$.findings[0].introducedByDiff: expected boolean, got string "true"'))
  assert.ok(f.errors.some((e) => e.startsWith('$.findings[0].severity: expected one of')))
  assert.deepEqual(validate(schemas.find, { findings: [] }), { ok: false, errors: ['$: missing required "reviewedCommit"'] })
})

// ---------------------------------------------------------------- backends

test('claude backend builds the documented argv for run and no-run, with the worktree as cwd and the diff dir added', async () => {
  const schema = { type: 'object', required: ['x'], properties: { x: { type: 'string' } } }
  const run = claude.commandFor({ prompt: 'P', schema, model: 'sonnet', addDirs: ['/d/diffs'], runCode: true, env: { ADV_REVIEW_CLAUDE_BIN: FAKE } })
  assert.equal(run.bin, FAKE)
  assert.deepEqual(run.args.slice(0, 2), ['-p', 'P'])
  const flag = (args, name) => args[args.indexOf(name) + 1]
  assert.equal(flag(run.args, '--json-schema'), JSON.stringify(schema))
  assert.equal(flag(run.args, '--model'), 'sonnet')
  assert.equal(flag(run.args, '--permission-mode'), 'acceptEdits')
  assert.equal(flag(run.args, '--permission-prompts'), 'none')
  assert.equal(flag(run.args, '--add-dir'), '/d/diffs')
  assert.ok(run.args.includes('--strict-mcp-config') && run.args.includes('--no-session-persistence'))
  assert.ok(!run.args.includes('--restricted'))
  const allowed = run.args.slice(run.args.indexOf('--allowedTools') + 1)
  assert.deepEqual(allowed, ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'], 'the variadic allow list ends the command')
  const ro = claude.commandFor({ prompt: 'P', schema, model: 'opus', runCode: false, env: {} })
  assert.ok(ro.args.includes('--restricted'))
  assert.equal(flag(ro.args, '--tools'), 'Bash,Read,Glob,Grep')
  assert.equal(flag(ro.args, '--permission-mode'), 'dontAsk')
  const roAllowed = ro.args.slice(ro.args.indexOf('--allowedTools') + 1)
  assert.ok(roAllowed.length >= 9 && roAllowed.every((a) => /^Bash\(git \w[\w-]* \*\)$/.test(a)), roAllowed.join(' '))
  const auto = claude.commandFor({ prompt: 'P', schema, model: 'opus', runCode: true, permissionMode: 'auto', env: {} })
  assert.equal(flag(auto.args, '--permission-mode'), 'auto')
  assert.ok(!auto.args.includes('--allowedTools'))
  // Through the fake: the answer comes from the cwd the backend was given.
  const { repo, mainSha } = tempRepo()
  await withFake({ mode: 'claude' }, async () => {
    const r = await claude.run({ prompt: 'P', schema: { type: 'object' }, model: 'opus', cwd: repo, addDirs: [], runCode: true, timeoutMs: 10_000, env: { ...process.env, ADV_REVIEW_LABEL: 'scout' } })
    assert.equal(r.ok, true)
    assert.equal(r.parsed.reviewedCommit, mainSha)
    assert.equal(r.cost.usd, 0.01)
    assert.equal(r.model, 'fake-claude')
  })
})

test('codex backend writes the schema file, passes -o, -C, -s per run mode, and reads the last message', async () => {
  const c = codex.commandFor({ prompt: 'P', schema: { type: 'object' }, schemaFile: '/t/s.json', outFile: '/t/o.json', cwd: '/w', runCode: true, env: { ADV_REVIEW_CODEX_BIN: FAKE } })
  assert.equal(c.bin, FAKE)
  assert.deepEqual(c.args.slice(0, 2), ['exec', 'P'])
  const flag = (args, name) => args[args.indexOf(name) + 1]
  assert.equal(flag(c.args, '-C'), '/w')
  assert.equal(flag(c.args, '-o'), '/t/o.json')
  assert.equal(flag(c.args, '--output-schema'), '/t/s.json')
  assert.equal(flag(c.args, '-s'), 'workspace-write')
  assert.ok(c.args.includes('--skip-git-repo-check') && c.args.includes('--ephemeral') && c.args.includes('--json'))
  assert.ok(!c.args.includes('-m'), 'no model flag unless the user gave one')
  const ro = codex.commandFor({ prompt: 'P', schema: {}, schemaFile: 's', outFile: 'o', cwd: '/w', runCode: false, model: 'gpt-x', env: {} })
  assert.equal(flag(ro.args, '-s'), 'read-only')
  assert.equal(flag(ro.args, '-m'), 'gpt-x')
  assert.ok(!ro.args.some((a) => a.includes('network_access')))
  const net = codex.commandFor({ prompt: 'P', schema: {}, schemaFile: 's', outFile: 'o', cwd: '/w', runCode: true, network: true, env: {} })
  assert.ok(net.args.includes('sandbox_workspace_write.network_access=true'))
  const { repo, mainSha } = tempRepo()
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'adv-codex-'))
  await withFake({ mode: 'codex' }, async () => {
    const r = await codex.run({ prompt: 'P', schema: { type: 'object', required: ['reviewedCommit'] }, model: null, cwd: repo, runCode: true, timeoutMs: 10_000, env: { ...process.env, ADV_REVIEW_LABEL: 'scout' }, tmp, seq: '1-1' })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.parsed.reviewedCommit, mainSha)
    assert.ok(existsSync(path.join(tmp, 'codex', '1-1.schema.json')), 'the schema was written for --output-schema')
    assert.equal(JSON.parse(await readFile(path.join(tmp, 'codex', '1-1.schema.json'), 'utf8')).required[0], 'reviewedCommit')
    assert.deepEqual(r.cost, { usd: null, inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 })
    assert.equal(r.model, 'fake-codex')
  })
})

test('gemini backend appends the schema instruction and extracts the first JSON object from a fenced response', async () => {
  const schema = { type: 'object', required: ['reviewedCommit'], properties: { reviewedCommit: { type: 'string' } } }
  const g = gemini.commandFor({ prompt: 'P', schema, addDirs: ['/d/diffs'], runCode: true, env: { ADV_REVIEW_GEMINI_BIN: FAKE } })
  assert.equal(g.bin, FAKE)
  assert.equal(g.args[0], '-p')
  assert.ok(g.args[1].startsWith('P\n\nAnswer with ONLY one JSON object'))
  assert.ok(g.args[1].includes('{ reviewedCommit: string }'))
  const flag = (args, name) => args[args.indexOf(name) + 1]
  assert.equal(flag(g.args, '--output-format'), 'json')
  assert.equal(flag(g.args, '--approval-mode'), 'yolo')
  assert.equal(flag(g.args, '--include-directories'), '/d/diffs')
  assert.equal(g.env.GEMINI_CLI_TRUST_WORKSPACE, 'true')
  const ro = gemini.commandFor({ prompt: 'P', schema, runCode: false, env: {} })
  assert.equal(flag(ro.args, '--approval-mode'), 'default')
  assert.equal(flag(ro.args, '--allowed-tools'), 'run_shell_command(git)')
  assert.deepEqual(extractJson('Sure!\n```json\n{"a": "}", "b": {"c": 1}}\n```\ntrailing'), { a: '}', b: { c: 1 } })
  assert.equal(extractJson('no json here'), null)
  const { repo, mainSha } = tempRepo()
  await withFake({ mode: 'gemini' }, async () => {
    const r = await gemini.run({ prompt: 'P', schema, model: null, cwd: repo, addDirs: [], runCode: true, timeoutMs: 10_000, env: { ...process.env, ADV_REVIEW_LABEL: 'scout' } })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.parsed.reviewedCommit, mainSha)
    assert.equal(r.model, 'fake-gemini')
    assert.equal(r.cost.inputTokens, 100)
  })
})

test('copilot backend asks for the JSON in the prompt, allows every tool only when code may run, and reads the answer from silent text output', async () => {
  const schema = { type: 'object', required: ['reviewedCommit'], properties: { reviewedCommit: { type: 'string' } } }
  const c = copilot.commandFor({ prompt: 'P', schema, addDirs: ['/d/diffs'], runCode: true, env: { ADV_REVIEW_COPILOT_BIN: FAKE } })
  assert.equal(c.bin, FAKE)
  assert.equal(c.args[0], '-p')
  assert.ok(c.args[1].startsWith('P\n\nAnswer with ONLY one JSON object'))
  for (const flag of ['-s', '--no-ask-user', '--allow-all-tools', '--add-dir=/d/diffs']) assert.ok(c.args.includes(flag), flag)
  assert.ok(!c.args.some((a) => a.startsWith('--model')), 'no model unless the user named one')
  assert.equal(c.env.GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS, 'false', "the repository's own extensions stay out of the agents")
  const ro = copilot.commandFor({ prompt: 'P', schema, model: 'gpt-5.4', runCode: false, env: {} })
  assert.ok(!ro.args.includes('--allow-all-tools'))
  for (const flag of ['--allow-tool=shell(git:*)', '--deny-tool=write', '--model=gpt-5.4']) assert.ok(ro.args.includes(flag), flag)
  const { repo, mainSha } = tempRepo()
  await withFake({ mode: 'copilot' }, async () => {
    const r = await copilot.run({ prompt: 'P', schema, model: null, cwd: repo, addDirs: [], runCode: true, timeoutMs: 10_000, env: { ...process.env, ADV_REVIEW_LABEL: 'scout', COPILOT_MODEL: 'gpt-5.4' } })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.parsed.reviewedCommit, mainSha, 'the JSON is picked out of the prose around it')
    assert.equal(r.model, 'gpt-5.4', 'the model is COPILOT_MODEL when the CLI reports none')
    assert.equal(r.cost, null, 'silent mode reports no usage')
    const bad = await copilot.run({ prompt: 'P', schema, model: null, cwd: repo, addDirs: [], runCode: true, timeoutMs: 10_000, env: { ...process.env, ADV_REVIEW_LABEL: 'scout', ADV_REVIEW_FAKE_SCRIPT: '' } })
    assert.equal(bad.ok, true)
  })
  await withFake({ mode: 'copilot', script: { scout: { __exitCode: 3 } } }, async () => {
    const r = await copilot.run({ prompt: 'P', schema, model: null, cwd: repo, addDirs: [], runCode: true, timeoutMs: 10_000, env: { ...process.env, ADV_REVIEW_LABEL: 'scout' } })
    assert.equal(r.ok, false)
    assert.match(r.reason, /exit 3/)
  })
})

// ---------------------------------------------------------------- engine

test('an invalid answer is retried once in the backend with the validation error, then returns null', async () => {
  const { schemas } = await collectSchemas()
  const { repo, headSha } = tempRepo()
  const bad = { verdicts: [{ index: 0, refuted: 'false', confidence: 'certain', reasoning: 'x' }] }
  const good = { verdicts: [{ index: 0, refuted: false, confidence: 'certain', reasoning: 'x' }] }
  await withFake({ script: { refute: [bad, good] } }, async ({ calls }) => {
    const { engine } = await engineOn({ repo, headSha })
    const r = await engine.agent('[0] HIGH — claim', { label: 'refute:1', schema: schemas.refute })
    assert.equal(r.verdicts[0].refuted, false)
    assert.equal(engine.stats.calls.length, 2)
    assert.equal(engine.stats.calls[0].ok, false)
    assert.match(engine.stats.calls[0].reason, /expected boolean, got string "false"/)
    assert.equal(engine.stats.calls[1].ok, true)
    const second = calls()[1]
    assert.equal(second.attempt, 2)
    assert.ok(second.argv[1].includes('Your previous answer was invalid: $.verdicts[0].refuted: expected boolean'))
  })
  await withFake({ script: { refute: [bad, bad] } }, async () => {
    const { engine } = await engineOn({ repo, headSha })
    assert.equal(await engine.agent('[0] HIGH — claim', { label: 'refute:1', schema: schemas.refute }), null)
    assert.equal(engine.stats.calls.length, 2)
  })
})

test('a process that outlives the timeout is killed and the agent returns null', async () => {
  const { repo, headSha } = tempRepo()
  await withFake({ script: { scout: { __sleepMs: 5000 } } }, async () => {
    const { engine } = await engineOn({ repo, headSha, options: { timeoutMs: 400 } })
    const started = Date.now()
    const r = await engine.agent('P', { label: 'scout', schema: { type: 'object' } })
    assert.equal(r, null)
    assert.ok(Date.now() - started < 4000, 'did not wait for the sleep')
    assert.match(engine.stats.calls[0].reason, /timed out/)
    assert.equal(engine.stats.calls.length, 1, 'a timeout is not retried in the backend')
    for (let i = 0; i < 50 && liveCount() > 0; i++) await new Promise((r) => setTimeout(r, 100))
    assert.equal(liveCount(), 0)
  })
})

test('each agent gets its own worktree at headSha, removed afterwards; prune leaves none', async () => {
  const { repo, headSha, mainSha } = tempRepo()
  const root = await mkdtemp(path.join(os.tmpdir(), 'adv-wt-'))
  const worktrees = await createWorktrees({ repo, headSha, root })
  const a = await worktrees.add('find:correctness')
  const b = await worktrees.add('refute:p1.2')
  assert.ok(a.dir.startsWith(root) && a.dir !== b.dir)
  assert.equal(path.basename(a.dir), '1-find-correctness', 'the label is sanitised in the path')
  assert.equal(git(a.dir, 'rev-parse', 'HEAD'), headSha)
  assert.notEqual(headSha, mainSha)
  assert.ok(existsSync(path.join(a.dir, 'b.txt')), 'the feature commit is checked out')
  assert.equal(worktrees.live(), 2)
  await worktrees.remove(a.id)
  assert.ok(!existsSync(a.dir))
  await worktrees.removeAll()
  await worktrees.prune()
  assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1)
  assert.equal(git(repo, 'status', '--porcelain'), '')
  // Through the engine: the fake reports the commit of its cwd, which must be the head.
  await withFake({}, async () => {
    const { engine } = await engineOn({ repo, headSha })
    const r = await engine.agent('P', { label: 'scout', schema: { type: 'object', required: ['reviewedCommit'] } })
    assert.equal(r.reviewedCommit, headSha)
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1)
  })
})

test('never more than --jobs processes alive', async () => {
  const { repo, headSha } = tempRepo()
  await withFake({ sleepMs: 150 }, async ({ calls }) => {
    const { engine } = await engineOn({ repo, headSha, jobs: 2 })
    const results = await engine.parallel(Array.from({ length: 6 }, (_, i) => () => engine.agent('P', { label: `find:a${i}`, schema: { type: 'object' } })))
    assert.equal(results.filter(Boolean).length, 6)
    const log = calls()
    assert.equal(log.length, 6)
    let peak = 0
    for (const c of log) {
      const overlapping = log.filter((o) => o.start < c.end && o.end > c.start).length
      peak = Math.max(peak, overlapping)
    }
    assert.ok(peak <= 2, `peak ${peak}`)
    assert.ok(peak === 2, 'two ran at once, so the limit is the only cap')
  })
})

test('parallel never rejects, keeps order, and hands back copies', async () => {
  const { repo, headSha } = tempRepo()
  const { engine } = await engineOn({ repo, headSha })
  const obj = { findings: [{ a: 1 }] }
  const out = await engine.parallel([
    () => obj,
    () => {
      throw new Error('boom')
    },
    () => undefined,
    async () => 'x',
    () => Promise.reject(new Error('later')),
  ])
  assert.deepEqual(out, [obj, null, null, 'x', null])
  assert.notEqual(out[0], obj)
})

test('the script\'s model is passed to claude only; codex, gemini and copilot get --model only when the user gave one', async () => {
  const { repo, headSha } = tempRepo()
  const seen = []
  const fakeBackend = (name) => ({ name, run: async (o) => { seen.push([name, o.model]); return { ok: true, parsed: { reviewedCommit: headSha }, cost: null } } })
  for (const [name, userModel] of [['claude', null], ['codex', null], ['codex', 'gpt-x'], ['gemini', 'pro'], ['copilot', null], ['copilot', 'gpt-5.4']]) {
    const { engine } = await engineOn({ repo, headSha, backend: fakeBackend(name), options: { userModel } })
    await engine.agent('P', { label: 'scout', schema: { type: 'object' }, model: 'sonnet' })
  }
  assert.deepEqual(seen, [['claude', 'sonnet'], ['codex', null], ['codex', 'gpt-x'], ['gemini', 'pro'], ['copilot', null], ['copilot', 'gpt-5.4']])
  const prepared = { target: { prs: [1] }, diffs: ['/d'], headSha, title: 't' }
  assert.equal(buildArgs(prepared, { agent: 'claude', model: null, run: true }, { model: 'sonnet' }).model, 'sonnet', 'a config model reaches Claude')
  assert.equal(buildArgs(prepared, { agent: 'codex', model: null, run: true }, { model: 'sonnet' }).model, undefined, 'a config model is a Claude name: not for codex')
  assert.equal(buildArgs(prepared, { agent: 'codex', model: 'gpt-x', run: true }, { model: 'sonnet' }).model, 'gpt-x')
  assert.equal(buildArgs(prepared, { agent: 'claude', model: null, run: false, agents: 8 }, { agents: 30 }).run, false)
  assert.equal(buildArgs(prepared, { agent: 'claude', model: null, run: true }, { agents: 30 }).agents, 30)
})

test('labels are sanitised in worktree paths', () => {
  assert.equal(safeName('find:own HOW TO REPORT'), 'find-own-HOW-TO-REPORT')
  assert.equal(safeName('refute:p1.2'), 'refute-p1.2')
  for (const ugly of ['../../etc', 'a/b/c', 'x'.repeat(200), '', null]) {
    const name = safeName(ugly)
    assert.ok(name.length > 0 && name.length <= 60 && !name.includes('/') && !name.includes(path.sep), `${ugly} -> ${name}`)
  }
})

test('end to end: the real script through the engine with the fake CLI answering every label', async () => {
  const { repo, headSha } = tempRepo()
  const diff = path.join(repo, '..', `adv-diff-${process.pid}.diff`)
  writeFileSync(diff, 'diff --git a/src/a.ts b/src/a.ts\n')
  await withFake({ script: { 'find:correctness': { findings: [finding()] } } }, async ({ calls }) => {
    const { engine, worktrees } = await engineOn({ repo, headSha, jobs: 3 })
    const result = await loadWorkflow().run({ prs: [1], title: 'T', diffs: [diff], headSha, agents: 20 }, engine)
    assert.equal(result.status, 'complete', JSON.stringify(result.incomplete))
    assert.equal(result.confirmed.length, 1)
    assert.equal(result.confirmed[0].title, 'A defect')
    assert.equal(result.budget.used, engine.stats.calls.length, 'no backend retries, so one call per agent')
    assert.equal(calls().length, engine.stats.calls.length)
    assert.ok(result.budget.used >= 4)
    assert.equal(worktrees.live(), 0)
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1)
    assert.ok(engine.stats.cost.usd > 0)
  })
})

// ---------------------------------------------------------------- command line and entry point

test('--post with --branch is refused before anything is spent', async () => {
  assert.throws(() => parseCli(['--branch', 'x', '--post']), (e) => e instanceof CliError && /nothing to post/.test(e.message))
  assert.throws(() => parseCli(['4', '--branch', 'x']), /not both/)
  assert.throws(() => parseCli(['--agent', 'gpt']), /--agent must be one of/)
  assert.deepEqual([parseCli(['--agent', 'codex:gpt-5.5']).agent, parseCli(['--agent', 'codex:gpt-5.5']).model], ['codex', 'gpt-5.5'], 'a model may follow the agent after a colon')
  assert.equal(parseCli(['--agent', 'claude:sonnet', '--model', 'sonnet']).model, 'sonnet')
  assert.throws(() => parseCli(['--agent', 'claude:sonnet', '--model', 'opus']), /given twice/)
  assert.throws(() => parseCli(['--agent', 'gpt:x']), /--agent must be one of/)
  assert.throws(() => parseCli(['--agents', '3']), /at least 4/)
  assert.throws(() => parseCli(['abc']), /not a pull request number/)
  const c = parseCli(['136', '140', '--branch'].slice(0, 2))
  assert.deepEqual(c.prs, [136, 140])
  const b = parseCli(['--branch', '--base', 'origin/dev', '--no-run', '--jobs', '2'])
  assert.equal(b.branchMode, true)
  assert.equal(b.branch, null, 'bare --branch means the current branch')
  assert.equal(b.base, 'origin/dev')
  assert.equal(b.run, false)
  assert.equal(b.jobs, 2)
  assert.equal(parseCli(['--branch', 'feat/x']).branch, 'feat/x')
  await withFake({}, async ({ calls }) => {
    const logs = []
    const code = await main(['--branch', 'x', '--post'], { log: (l) => logs.push(l), stdout: () => {} })
    assert.equal(code, 2)
    assert.ok(logs[0].includes('nothing to post'))
    assert.equal(calls().length, 0)
  })
})

test('--dry-run prepares, prints args and a command line, and spawns nothing', async () => {
  const { repo, headSha } = tempRepo()
  await withFake({}, async ({ calls }) => {
    const out = []
    const logs = []
    const code = await main(['--branch', 'feature', '--base', 'main', '--repo', repo, '--dry-run', '--no-run'], { log: (l) => logs.push(l), stdout: (s) => out.push(s) })
    assert.equal(code, 0, logs.join('\n'))
    const printed = JSON.parse(out[0])
    assert.equal(printed.args.branch, 'feature')
    assert.equal(printed.args.base, 'main')
    assert.equal(printed.args.headSha, headSha)
    assert.equal(printed.args.title, 'Add b')
    assert.equal(printed.args.run, false)
    assert.ok(printed.args.diffs[0].endsWith('branch-feature.diff'))
    assert.ok(out[1].startsWith('sample command: ') && out[1].includes('--restricted'))
    assert.equal(calls().length, 0)
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1)
  })
})

test('--out writes the result with a runner block the scorer ignores', async () => {
  const { repo, headSha } = tempRepo()
  const outFile = path.join(repo, '..', `adv-out-${process.pid}.json`)
  await withFake({ script: { 'find:correctness': { findings: [finding()] } } }, async () => {
    const logs = []
    const code = await main(['--branch', 'feature', '--base', 'main', '--repo', repo, '--out', outFile, '--jobs', '2', '--agents', '20'], { log: (l) => logs.push(l), stdout: () => {} })
    assert.equal(code, 0, logs.join('\n'))
    const result = JSON.parse(await readFile(outFile, 'utf8'))
    assert.equal(result.status, 'complete')
    assert.deepEqual(result.target, { branch: 'feature', base: 'main' })
    assert.equal(result.runner.agent, 'claude')
    assert.equal(result.runner.model, 'fake-claude')
    assert.equal(result.runner.version, JSON.parse(await readFile(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version, 'the runner records the plugin version')
    assert.ok(result.runner.calls.length >= 4)
    assert.equal(result.runner.intent, 'commits')
    const manifest = { repository: 'o/r', defects: [{ id: 'D1', pr: 1, angle: 'correctness', severity: 'high', sites: [{ file: 'src/a.ts', lines: [10, 10] }] }], clean: [] }
    const scored = score({ manifest, results: [{ pr: 1, result }] })
    assert.deepEqual(scored.rows[0].found.map((f) => f.id), ['D1'])
    assert.equal(scored.summary.precision, 1)
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1)
    assert.equal(git(repo, 'status', '--porcelain'), '')
  })
})

test('intent is the author\'s text, bounded and labelled as verbatim', () => {
  assert.equal(intentFrom('  Adds   a thing\n\nSo that.  '), 'verbatim excerpt, not a summary: Adds a thing So that.')
  assert.equal(intentFrom(''), null)
  const long = intentFrom('x'.repeat(2000))
  assert.ok(long.length < 1100 && long.endsWith('…'))
})

test("claude's reported model is the one that did the work, not the helper model listed first", () => {
  assert.equal(claude.mainModel({ 'claude-haiku-4-5': { inputTokens: 900, outputTokens: 40 }, 'claude-sonnet-5': { inputTokens: 50_000, outputTokens: 3_000 } }), 'claude-sonnet-5')
  assert.equal(claude.mainModel({ only: { inputTokens: 1, outputTokens: 1 } }), 'only')
  assert.equal(claude.mainModel(undefined), null)
})

test("codex's default model is read from its config, since its events do not name one", () => {
  assert.equal(codex.defaultModelFrom('# comment\nmodel = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n'), 'gpt-5.6-sol')
  assert.equal(codex.defaultModelFrom('[profiles.x]\n  model = "inner"\n'), 'inner')
  assert.equal(codex.defaultModelFrom('no model here\n'), null)
  assert.equal(codex.defaultModelFrom(''), null)
})

test('every agent is told to carry on when its worktree is already at the head', async () => {
  const { repo, headSha } = tempRepo()
  await withFake({}, async ({ calls }) => {
    const { engine } = await engineOn({ repo, headSha })
    await engine.agent('P', { label: 'scout', schema: { type: 'object' } })
    const source = readFileSync(path.join(here, '..', 'workflows', 'adversarial.js'), 'utf8')
    assert.ok(source.includes('If that already prints the commit below, you are in place: carry on.'))
    assert.ok(source.includes('If HEAD is not the commit\nbelow and the checkout fails, stop'))
    assert.equal(calls().length, 1)
  })
  await rm(repo, { recursive: true, force: true })
})

test('the skill names the runner for agents without a Workflow tool', () => {
  const skill = readFileSync(SKILL, 'utf8')
  assert.ok(skill.includes('runner/review.mjs'))
  assert.ok(skill.includes('--agent <codex|gemini|copilot|claude>'))
  assert.ok(skill.includes('ADV_REVIEW_HOME'))
  assert.ok(skill.includes('$CLAUDE_PLUGIN_ROOT'), 'the installed plugin finds its runner')
  assert.ok(skill.includes('`--agent codex|gemini|copilot` — run the review with that CLI'), 'the flag is in the argument list, so Claude Code sessions take it')
  assert.ok(skill.includes('`--agent claude,codex` — two or more agents'), 'a comma-separated list means a comparison')
  assert.ok(skill.includes('runner/compare.mjs'), 'the comparison is the compare command')
  assert.ok(skill.includes('`--compare <file> <file>...` — no review'), 'results written earlier can be compared without a new review')
})
