import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compare, labelReviews, main, render, similar, words } from '../runner/compare.mjs'

const HEAD = '0bf23917ade72ebeb93704c555a8504baff245e7'
const finding = (file, line, title, severity = 'high', extra = {}) => ({ file, line, title, severity, summary: `${title}.`, ...extra })
const review = ({ agent, model, usd = null, tokens = null, elapsedMs, used, confirmed = [], refuted = [], headSha = HEAD }) => ({
  status: 'complete',
  headSha,
  target: { prs: [14] },
  budget: { ceiling: 20, used },
  confirmed,
  refuted,
  runner: { agent, model, elapsedMs, cost: usd !== null ? { usd } : { usd: null, inputTokens: tokens, outputTokens: 108_000 }, calls: [] },
})

const claude = review({
  agent: 'claude',
  model: 'claude-sonnet-5',
  usd: 3.94,
  elapsedMs: 900_000,
  used: 19,
  confirmed: [finding('src/a.js', 18, 'Path traversal in the export name', 'critical'), finding('src/b.js', 5, 'Only Claude saw this', 'medium'), finding('src/a.js', 19, 'Export directory listing is public', 'low')],
})
const codex = review({
  agent: 'codex',
  model: 'gpt-5.6-sol',
  tokens: 4_600_000,
  elapsedMs: 660_000,
  used: 18,
  confirmed: [finding('src/a.js', 20, 'Export name path traversal', 'high'), finding('src/c.js', 40, 'Only Codex saw this', 'low', { preexisting: true })],
  refuted: [finding('src/b.js', 7, 'Only Claude saw this, now refuted')],
})

test('findings within the window are one place; the rest are listed by who found them, with each run\'s agent, model, time and cost', () => {
  const cmp = compare([
    { name: 'claude', result: claude },
    { name: 'codex', result: codex },
  ])
  assert.equal(cmp.headSha, HEAD)
  const shared = cmp.groups.filter((g) => g.by.length === 2)
  assert.equal(shared.length, 1)
  assert.deepEqual(shared[0].by, ['claude', 'codex'])
  assert.equal(shared[0].severity, 'critical', 'the group carries the most severe rating')
  assert.deepEqual(cmp.groups.filter((g) => g.by.length === 1).map((g) => `${g.file}:${g.line} ${g.by[0]}`), ['src/b.js:5 claude', 'src/a.js:19 claude', 'src/c.js:40 codex'])
  const listing = cmp.groups.find((g) => g.line === 19)
  assert.deepEqual(listing.alsoHere, [], "codex's finding at this place is already paired with claude's traversal finding, so it is not 'something else'")
  const text = render(cmp)
  assert.match(text, /Compared 2 reviews of PR #14 at 0bf23917:/)
  assert.match(text, /claude {2}claude-sonnet-5; 19 agents, 15 min, \$3\.94; 3 confirmed, 0 refuted/)
  assert.match(text, /codex {3}gpt-5\.6-sol; 18 agents, 11 min, 4\.7M tokens; 2 confirmed, 1 refuted/)
  assert.match(text, /Found by every agent \(1\):\n {2}\[CRITICAL\] src\/a\.js:18 Path traversal in the export name \(codex: high\)/)
  assert.match(text, /\[LOW\] src\/c\.js:40 Only Codex saw this \(pre-existing\) — found by codex only/)
})

test('two different findings on one line stay apart, each noting that the other agent reports something else there', () => {
  assert.deepEqual(words("Hourly timer races request handlers' store.save()"), ['hourly', 'timer', 'race', 'request', 'handler', 'store', 'save'])
  assert.ok(similar({ title: 'Path traversal in export name escapes exports dir' }, { title: 'Named exports escape export directory' }))
  assert.ok(!similar({ title: 'Path traversal in export name escapes exports dir' }, { title: 'Named exports grow storage unbounded' }))
  assert.ok(similar({ title: 'Hourly save races request saves' }, { title: "Hourly timer races request handlers' store.save()" }))
  assert.ok(similar({ title: 'Local and UTC days diverge' }, { title: 'Local-vs-UTC day mismatch double-credits interest' }))
  assert.ok(!similar({ title: 'Restart loops prevent all accrual' }, { title: 'Hourly job blocks event loop under load' }))
  const a = review({ agent: 'claude', model: 'm', usd: 1, elapsedMs: 1, used: 4, confirmed: [finding('src/s.js', 162, 'Hourly job blocks event loop under load')] })
  const b = review({ agent: 'codex', model: 'm', tokens: 1, elapsedMs: 1, used: 4, confirmed: [finding('src/s.js', 162, 'Restart loops prevent all accrual')] })
  const cmp = compare([
    { name: 'claude', result: a },
    { name: 'codex', result: b },
  ])
  assert.equal(cmp.groups.length, 2)
  assert.deepEqual(cmp.groups.map((g) => g.alsoHere.map((o) => `${o.name}: ${o.title}`)), [['codex: Restart loops prevent all accrual'], ['claude: Hourly job blocks event loop under load']])
  const text = render(cmp)
  assert.match(text, /Found by every agent \(0\)/)
  assert.match(text, /Hourly job blocks event loop under load — found by claude only\n {6}codex found something else at this place: "Restart loops prevent all accrual"/)
})

test('a finding one agent confirmed and another refuted is marked as disputed', () => {
  const cmp = compare([
    { name: 'claude', result: claude },
    { name: 'codex', result: codex },
  ])
  const disputed = cmp.groups.find((g) => g.file === 'src/b.js')
  assert.deepEqual(disputed.refutedBy, ['codex'])
  const text = render(cmp)
  assert.match(text, /\[MEDIUM\] src\/b\.js:5 Only Claude saw this — found by claude only; refuted by codex/)
  assert.match(text, /Confirmed by one agent and refuted by another: 1\./)
})

test('reviews of different commits, or fewer than two, are refused before anything is printed', () => {
  const other = review({ agent: 'codex', model: 'gpt-5.6-sol', tokens: 1, elapsedMs: 1, used: 4, headSha: 'deadbeef'.repeat(5) })
  assert.throws(() => compare([{ name: 'a', result: claude }, { name: 'b', result: other }]), /different commits \(0bf23917, deadbeef\)/)
  assert.throws(() => compare([{ name: 'a', result: claude }]), /at least two/)
  const errors = []
  const printed = []
  const files = { 'a.json': JSON.stringify(claude), 'b.json': JSON.stringify(other) }
  assert.equal(main(['a.json', 'b.json'], { stdout: (s) => printed.push(s), stderr: (s) => errors.push(s), read: (f) => files[f] }), 2)
  assert.equal(printed.length, 0)
  assert.match(errors[0], /different commits/)
})

test('two runs of one agent are told apart by model, then by number; the command prints text or JSON', () => {
  const opus = { ...claude, runner: { ...claude.runner, model: 'claude-opus-5' } }
  assert.deepEqual(labelReviews([{ file: 'x.json', result: claude }, { file: 'y.json', result: opus }, { file: 'z.json', result: codex }]), ['claude claude-sonnet-5', 'claude claude-opus-5', 'codex'])
  assert.deepEqual(labelReviews([{ file: 'x.json', result: claude }, { file: 'y.json', result: claude }]), ['claude claude-sonnet-5', 'claude claude-sonnet-5 #2'])
  assert.deepEqual(labelReviews([{ file: 'plugin-run.json', result: { ...claude, runner: undefined } }, { file: 'c.json', result: codex }]), ['plugin-run', 'codex'])
  const printed = []
  const files = { 'a.json': JSON.stringify(claude), 'b.json': JSON.stringify(codex) }
  assert.equal(main(['a.json', 'b.json', '--json'], { stdout: (s) => printed.push(s), read: (f) => files[f] }), 0)
  const parsed = JSON.parse(printed[0])
  assert.deepEqual(parsed.runs.map((r) => r.name), ['claude', 'codex'])
  assert.equal(parsed.groups.length, 4)
  printed.length = 0
  assert.equal(main(['a.json', 'b.json', '--window', '0'], { stdout: (s) => printed.push(s), read: (f) => files[f] }), 0)
  assert.match(printed[0], /Found by every agent \(0\)/, 'with no window, lines 18 and 20 are two places')
})
