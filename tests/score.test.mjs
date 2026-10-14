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

test('two findings on one planted defect count the defect once and both findings as true', () => {
  const results = [{ pr: 1, result: { confirmed: [finding('src/b.js', 10), finding('src/c.js', 5)] } }]
  const { rows, summary } = score({ manifest, results })
  assert.deepEqual(rows[0].found.map((f) => f.id), ['D2'])
  assert.equal(rows[0].plantedMatched, 2)
  assert.equal(summary.found, 1)
  assert.equal(summary.precision, 1)
  assert.match(format({ rows, summary }), /2 of 2 confirmed findings true \(2 on planted defects/)
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

test('a hand adjudication settles an unplanted finding either way; unadjudicated ones count as false', () => {
  const adjudicated = [
    { pr: 1, truth: true, title: 'test blind to the defect', sites: [{ file: 'test/x.test.js', lines: [30, 30] }] },
    { pr: 1, truth: false, title: 'style, not a defect', sites: [{ file: 'src/e.js', lines: [1, 1] }] },
  ]
  const results = [{ pr: 1, result: { confirmed: [finding('src/a.js', 40), finding('test/x.test.js', 32), finding('src/e.js', 2), finding('src/f.js', 9)] } }]
  const { rows, summary } = score({ manifest: { ...manifest, adjudicated }, results })
  assert.deepEqual(rows[0].adjudicatedTrue, ['test/x.test.js:32 t test/x.test.js [high]'])
  assert.deepEqual(rows[0].adjudicatedFalse, ['src/e.js:2 t src/e.js [high]'])
  assert.deepEqual(rows[0].unplanned, ['src/f.js:9 t src/f.js [high]'])
  assert.equal(summary.precision, 0.5, 'planted + adjudicated true over all four; the unadjudicated one counts false')
  const text = format({ rows, summary })
  assert.match(text, /true, unplanted: test\/x\.test\.js:32/)
  assert.match(text, /FALSE POSITIVE: src\/e\.js:2/)
  assert.match(text, /precision 50%: 2 of 4 confirmed findings true \(1 on planted defects, 0 known, 1 adjudicated true\); 1 adjudicated false; 1 to adjudicate, counted false/)
  assert.equal(summary.plantedMatched, 1)
  // An adjudication is per PR: the same site on another PR is still unplanned.
  const other = score({ manifest: { ...manifest, adjudicated }, results: [{ pr: 2, result: { confirmed: [finding('test/x.test.js', 32)] } }] })
  assert.deepEqual(other.rows[0].unplanned, ['test/x.test.js:32 t test/x.test.js [high]'])
})

test("a ruling on the finding's own site outranks a planted line among its grouped sites", () => {
  const adjudicated = [{ pr: 1, truth: false, title: 'coverage note', sites: [{ file: 'test/y.test.js', lines: [4, 4] }] }]
  const grouped = { ...finding('test/y.test.js', 4), sites: [{ file: 'test/y.test.js', line: 4 }, { file: 'src/c.js', line: 5 }] }
  const { rows, summary } = score({ manifest: { ...manifest, adjudicated }, results: [{ pr: 1, result: { confirmed: [grouped] } }] })
  assert.deepEqual(rows[0].adjudicatedFalse, ['test/y.test.js:4 t test/y.test.js [high]'])
  assert.deepEqual(rows[0].found, [])
  assert.deepEqual(rows[0].missed, ['D1', 'D2'])
  assert.equal(summary.precision, 0)
  // Without the ruling, the overlap counts it as a match on D2.
  const unruled = score({ manifest, results: [{ pr: 1, result: { confirmed: [grouped] } }] })
  assert.deepEqual(unruled.rows[0].found.map((f) => f.id), ['D2'])
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
  assert.match(text, /precision 100%: 1 of 1 confirmed findings true \(1 on planted defects, 0 known, 0 adjudicated true\); 0 adjudicated false; 0 to adjudicate, counted false; 0 pre-existing left out/)
  assert.match(text, /by angle: correctness 1\/1, security 0\/1/)
})

test('results are summarised per set as well as overall, and a set can be scored alone', () => {
  const sets2 = {
    ...manifest,
    defects: [
      ...manifest.defects.map((d) => ({ ...d, set: 'v1' })),
      { id: 'D9', pr: 9, set: 'v2', angle: 'security', severity: 'high', sites: [{ file: 'src/z.js', lines: [3, 3] }] },
    ],
    clean: [{ pr: 3, set: 'v1' }, { pr: 10, set: 'v2' }],
  }
  const results = [
    { pr: 1, result: { confirmed: [finding('src/a.js', 40)] } },
    { pr: 9, result: { confirmed: [finding('src/z.js', 3)] } },
    { pr: 10, result: { confirmed: [finding('src/q.js', 1)] } },
  ]
  const both = score({ manifest: sets2, results })
  assert.equal(both.summary.recall, 2 / 3)
  assert.deepEqual(Object.keys(both.summary.bySet), ['v1', 'v2'])
  assert.equal(both.summary.bySet.v1.recall, 0.5)
  assert.equal(both.summary.bySet.v2.recall, 1)
  assert.equal(both.summary.bySet.v2.precision, 0.5)
  assert.equal(both.summary.bySet.v2.reviewed, 2)
  assert.deepEqual(both.summary.bySet.v2.byAngle, { security: { planted: 1, found: 1 } })
  const text = format(both)
  assert.match(text, /set v1: recall 50% \(1 of 2\), precision 100% \(1 of 1\) across 1 PRs/)
  assert.match(text, /set v2: recall 100% \(1 of 1\), precision 50% \(1 of 2\) across 2 PRs/)
  const v2 = score({ manifest: sets2, results, sets: ['v2'] })
  assert.deepEqual(v2.rows.map((r) => r.pr), [9, 10])
  assert.equal(v2.summary.recall, 1)
  assert.doesNotMatch(format(v2), /^set /m, 'one set: no per-set lines')
})

test('a missed defect the critic named is reported as such, and still counts as missed', () => {
  const results = [{ pr: 1, result: { confirmed: [finding('src/a.js', 40)], missed: [{ what: 'src/c.js still calls the old signature', why: 'outside the diff' }] } }]
  const { rows, summary } = score({ manifest, results })
  assert.deepEqual(rows[0].missed, ['D2'])
  assert.deepEqual(rows[0].surfacedByCritic, ['D2'], 'D2 has a site in src/c.js')
  assert.equal(summary.recall, 0.5)
  assert.equal(summary.surfacedByCritic, 1)
  const text = format({ rows, summary })
  assert.match(text, /MISSED D2 \(named by the critic, unverified\)/)
  assert.match(text, /1 missed, 1 of them named by the critic\)/)
  const unnamed = score({ manifest, results: [{ pr: 1, result: { confirmed: [], missed: [{ what: 'something in src/zz.js', why: 'x' }] } }] })
  assert.deepEqual(unnamed.rows[0].surfacedByCritic, [])
})
