import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { costCell, fromLogs, loadBench, renderTable } from '../calibration/bench-table.mjs'

const manifest = {
  repository: 'o/r',
  defects: [
    { id: 'D4', pr: 4, angle: 'correctness', severity: 'high', sites: [{ file: 'src/server.js', lines: [92, 92] }] },
    { id: 'D7', pr: 7, angle: 'security', severity: 'high', sites: [{ file: 'src/export.js', lines: [18, 18] }] },
  ],
  clean: [{ pr: 11 }],
}
const finding = (file, line) => ({ file, line, title: `t ${file}`, severity: 'high', foundBy: ['x'] })
const codexRunner = (calls, elapsedMs, cost) => ({ version: '0.5.0', agent: 'codex', model: 'gpt-5.6-sol', cliVersion: 'codex-cli 0.153.4', jobs: 3, elapsedMs, cost, calls: Array.from({ length: calls }, () => ({ ok: true })) })

test('a runner benchmark renders one row per result with the scorer verdict and what it spent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-'))
  await writeFile(
    path.join(dir, 'pr-4.json'),
    JSON.stringify({ status: 'complete', budget: { used: 18 }, confirmed: [finding('src/server.js', 92)], runner: codexRunner(18, 687_900, { usd: null, inputTokens: 4_462_161, cachedInputTokens: 3_968_384, outputTokens: 72_065 }) }),
  )
  await writeFile(path.join(dir, 'pr-11.json'), JSON.stringify({ status: 'complete', budget: { used: 4 }, confirmed: [], runner: codexRunner(4, 300_000, { usd: null, inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 10_000 }) }))
  const plain = renderTable(loadBench({ resultsDir: dir, manifest }))
  assert.ok(plain.includes('| PR | Planted | Other confirmed findings | Agents | Calls | Minutes |\n'), 'no spend column unless asked')
  assert.ok(plain.includes('| #4 | D4 ✓ | — | 18 | 18 | 11 |\n'), plain)
  assert.ok(!/\$|tokens|M in/.test(plain), 'no amounts without --cost')
  const table = renderTable(loadBench({ resultsDir: dir, manifest }), { cost: true })
  const lines = table.split('\n')
  assert.equal(lines[0], `**${path.basename(dir)}**: codex agents on gpt-5.6-sol (codex-cli 0.153.4, 3 at once)`)
  assert.ok(lines.includes('| #4 | D4 ✓ | — | 18 | 18 | 11 | 4.5M in (89% cached), 72k out |'), table)
  assert.ok(lines.includes('| #11 | clean; none reported | — | 4 | 4 | 5 | 1.0M in (50% cached), 10k out |'), table)
  assert.ok(lines.indexOf(lines.find((l) => l.startsWith('| #4'))) < lines.indexOf(lines.find((l) => l.startsWith('| #11'))), 'rows are in PR order')
})

test('a plugin-path result takes its cost from the session log and its minutes from the progress log', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-'))
  await mkdir(path.join(dir, 'logs'))
  await writeFile(path.join(dir, 'pr-7.json'), JSON.stringify({ status: 'complete', budget: { used: 20 }, confirmed: [finding('src/export.js', 18), finding('src/other.js', 3)] }))
  await writeFile(path.join(dir, 'logs', 'pr-7.jsonl'), ['{"type":"assistant"}', '{"type":"result","total_cost_usd":1.0}', 'not json', '{"type":"result","total_cost_usd":5.7728}'].join('\n'))
  await writeFile(path.join(dir, 'logs', 'progress-lane1.log'), '=== PR #7 start\n=== PR #7 done after 19 min; result: present [lane1]\n')
  assert.deepEqual(fromLogs({ pr: 7, logsDir: path.join(dir, 'logs') }), { cost: { usd: 5.7728 }, elapsedMs: 19 * 60_000 }, 'the last result line of the session is its total')
  const table = renderTable(loadBench({ resultsDir: dir, manifest }), { cost: true })
  assert.equal(table.split('\n')[0], `**${path.basename(dir)}**: plugin path`)
  assert.ok(table.includes('| #7 | D7 ✓ | 1 false (1 unruled) | 20 | — | 19 | $5.77 |'), table)
})

test('planted cells say missed or refuted, an incomplete run is marked, and costs fall back to a dash', () => {
  const row = (extra) => ({ pr: 4, kind: 'planted', planted: ['D4'], found: [], wronglyRefuted: [], confirmedCount: 0, adjudicatedTrue: [], adjudicatedFalse: [], unplanned: [], known: [], preexisting: [], ...extra })
  const bench = {
    name: 'x',
    rows: [
      { pr: 4, result: { status: 'incomplete', budget: { used: 9 } }, row: row({}), spent: { cost: null, elapsedMs: null, calls: null } },
      { pr: 4, result: { status: 'complete', budget: { used: 9 } }, row: row({ wronglyRefuted: [{ id: 'D4' }], adjudicatedTrue: ['a'], adjudicatedFalse: ['b'], preexisting: ['c'] }), spent: { cost: { usd: 3.0238 }, elapsedMs: 972_404, calls: 10 } },
      { pr: 9, result: {}, row: { pr: 9, note: 'not in the manifest — skipped' }, spent: {} },
    ],
  }
  const table = renderTable(bench, { cost: true })
  assert.ok(table.includes('| #4 (incomplete) | D4 missed | — | 9 | — | — | — |'), table)
  assert.ok(table.includes('| #4 | D4 refuted | 1 true, 1 false, 1 pre-existing | 9 | 10 | 16 | $3.02 |'), table)
  assert.ok(table.includes('| #9 | not in the manifest — skipped |'), table)
  assert.equal(costCell({ usd: null, inputTokens: 0, outputTokens: 0 }), '—')
})
