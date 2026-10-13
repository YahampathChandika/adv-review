import assert from 'node:assert/strict'
import { test } from 'node:test'
import { format, score } from '../calibration/lib.mjs'

const manifest = {
  repository: 'o/r',
  defects: [
    { id: 'D1', pr: 1, angle: 'correctness', severity: 'high', sites: [{ file: 'src/a.js', lines: [40, 42] }] },
    { id: 'D2', pr: 1, angle: 'security', severity: 'high', sites: [{ file: 'src/b.js', lines: [10, 10] }, { file: 'src/c.js', lines: [5, 5] }] },
    { id: 'D3', pr: 2, angle: 'correctness', severity: 'medium', sites: [{ file: 'src/d.js', lines: [1, 1] }] },
  ],
  clean: [{ pr: 3 }],
  known: [{ id: 'K1', sites: [{ file: 'src/auth.js', lines: [8, 8] }] }],
}
const finding = (file, line, extra = {}) => ({ file, line, title: `t ${file}`, severity: 'high', foundBy: ['x'], ...extra })

test('a confirmed finding within the window counts the defect as found, by the angle that found it', () => {
  const results = [{ pr: 1, result: { status: 'complete', budget: { used: 9 }, confirmed: [finding('src/a.js', 47, { foundBy: ['correctness', 'critic'] })], refuted: [] } }]
  const { rows, summary } = score({ manifest, results })
  assert.deepEqual(rows[0].found, [{ id: 'D1', foundBy: ['correctness', 'critic'], severity: 'high', verdict: null }])
  assert.deepEqual(rows[0].missed, ['D2'])
  assert.equal(summary.recall, 0.5)
  assert.equal(summary.precision, 1)
  assert.deepEqual(summary.byAngle, { correctness: { planted: 1, found: 1 }, security: { planted: 1, found: 0 } })
})

test('the window is inclusive on both sides and one line past it does not match', () => {
  const at = (line) => score({ manifest, results: [{ pr: 2, result: { confirmed: [finding('src/d.js', line)] } }] }).rows[0]
  assert.deepEqual(at(6).found.map((f) => f.id), ['D3'])
  assert.deepEqual(at(7).found, [])
  assert.deepEqual(at(7).unplanned, ['src/d.js:7 t src/d.js [high]'])
  assert.deepEqual(score({ manifest, results: [{ pr: 2, result: { confirmed: [finding('src/d.js', 7)] } }], window: 6 }).rows[0].found.map((f) => f.id), ['D3'])
})

test('a finding matches through any of its sites, and a defect through any of its sites', () => {
  const grouped = { file: 'src/zzz.js', line: 1, title: 'g', severity: 'high', sites: [{ file: 'src/zzz.js', line: 1 }, { file: 'src/c.js', line: 5 }] }
  const { rows } = score({ manifest, results: [{ pr: 1, result: { confirmed: [grouped] } }] })
  assert.deepEqual(rows[0].found.map((f) => f.id), ['D2'])
  assert.deepEqual(rows[0].unplanned, [])
})

test('a planted defect that was found and then refuted is reported as wrongly refuted, with whether it died only for doubt', () => {
  const results = [{ pr: 1, result: { confirmed: [], refuted: [finding('src/a.js', 41, { dismissedAsUnsure: true, reason: 'nobody could build the input' }), finding('src/b.js', 12, { dismissedAsUnsure: false })] } }]
  const { rows, summary } = score({ manifest, results })
  assert.deepEqual(rows[0].wronglyRefuted, [
    { id: 'D1', foundBy: ['x'], dismissedAsUnsure: true, reason: 'nobody could build the input' },
    { id: 'D2', foundBy: ['x'], dismissedAsUnsure: false, reason: null },
  ])
  assert.deepEqual(rows[0].missed, [])
  assert.equal(summary.recall, 0)
  assert.equal(summary.wronglyRefuted, 2)
  assert.match(format({ rows, summary }), /WRONGLY REFUTED D1 \(only for doubt\), D2/)
})

test('on a clean PR, a known defect and a pre-existing finding do not count against precision; anything else does', () => {
  const results = [{ pr: 3, result: { status: 'complete', confirmed: [finding('src/auth.js', 9), finding('src/x.js', 3, { preexisting: true }), finding('src/y.js', 1)] } }]
  const { rows, summary } = score({ manifest, results })
  assert.equal(rows[0].kind, 'clean')
  assert.deepEqual(rows[0].known, ['src/auth.js:9 t src/auth.js [high]'])
  assert.deepEqual(rows[0].preexisting, ['src/x.js:3 t src/x.js [high]'])
  assert.deepEqual(rows[0].unplanned, ['src/y.js:1 t src/y.js [high]'])
  assert.equal(summary.precision, 0.5)
  assert.equal(summary.recall, null)
})

test('a result for a commit that is no longer the head is skipped, as is one for a PR the manifest does not list', () => {
  const results = [
    { pr: 1, result: { headSha: 'aaaa111', confirmed: [finding('src/a.js', 40)] } },
    { pr: 2, result: { headSha: 'bbbb222', confirmed: [finding('src/d.js', 1)] } },
    { pr: 9, result: { confirmed: [finding('src/d.js', 1)] } },
  ]
  const { rows, summary } = score({ manifest, results, heads: { 1: 'aaaa111000', 2: 'cccc333' } })
  assert.deepEqual(rows.map((r) => r.pr), [1, 2, 9])
  assert.equal(rows[0].found.length, 1, 'a short sha that prefixes the head is the head')
  assert.match(rows[1].note, /^stale: reviewed bbbb222, the PR is at cccc333/)
  assert.match(rows[2].note, /not in the manifest/)
  assert.equal(summary.reviewed, 1)
  assert.equal(summary.planted, 2)
})

test('the text report carries the counts a reader needs', () => {
  const results = [{ pr: 1, result: { status: 'incomplete', budget: { used: 12 }, confirmed: [finding('src/a.js', 40, { foundBy: ['correctness'] })], refuted: [] } }]
  const text = format(score({ manifest, results }))
  assert.match(text, /PR #1 \(planted, incomplete, 12 agents\)/)
  assert.match(text, /planted D1, D2 → found D1 by correctness; MISSED D2/)
  assert.match(text, /recall 50%: 1 of 2 planted defects confirmed \(0 found then wrongly refuted, 1 missed\) across 1 PRs/)
  assert.match(text, /precision 100%: 1 of 1 confirmed findings planted or known; 0 to adjudicate; 0 pre-existing left out/)
  assert.match(text, /by angle: correctness 1\/1, security 0\/1/)
})
