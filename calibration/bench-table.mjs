#!/usr/bin/env node
// A Markdown table of a benchmark: one row per result file, scored offline
// against the manifest, with what each review spent. The standalone runner
// records that under `runner`; for a plugin-path result the session log beside
// it (`logs/pr-<n>.jsonl`) gives the cost and the progress log the minutes.
//
//   node calibration/bench-table.mjs --results calibration/results/0.5.0-codex [--results …] [--manifest …] [--cost]
//
// The table carries the verdict, the agents and the minutes; `--cost` adds what each
// review spent, for the maintainers' own records.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { score } from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

const minutes = (ms) => (typeof ms === 'number' ? `${Math.round(ms / 60_000)}` : '—')
const money = (usd) => `$${usd.toFixed(2)}`
const millions = (n) => `${(n / 1e6).toFixed(1)}M`

/** What a review spent, as one cell: dollars where the CLI reports them, tokens otherwise. */
export const costCell = (cost) => {
  if (!cost) return '—'
  if (typeof cost.usd === 'number') return money(cost.usd)
  const inTok = Number(cost.inputTokens ?? 0)
  const cached = Number(cost.cachedInputTokens ?? 0)
  const out = Number(cost.outputTokens ?? 0)
  if (!inTok && !out) return '—'
  return `${millions(inTok)} in (${inTok ? Math.round((cached / inTok) * 100) : 0}% cached), ${Math.round(out / 1000)}k out`
}

/** The cost and minutes of a plugin-path review, from the logs beside its result. */
export function fromLogs({ pr, logsDir }) {
  const out = { cost: null, elapsedMs: null }
  try {
    const lines = readFileSync(path.join(logsDir, `pr-${pr}.jsonl`), 'utf8').split('\n')
    for (const line of lines) {
      try {
        const o = JSON.parse(line)
        if (o.type === 'result' && typeof o.total_cost_usd === 'number') out.cost = { usd: o.total_cost_usd }
      } catch {}
    }
  } catch {}
  try {
    for (const f of readdirSync(logsDir).filter((f) => /^progress.*\.log$/.test(f))) {
      const m = readFileSync(path.join(logsDir, f), 'utf8').match(new RegExp(`PR #${pr} done after (\\d+) min`))
      if (m) out.elapsedMs = Number(m[1]) * 60_000
    }
  } catch {}
  return out
}

const plantedCell = (row) => {
  if (row.kind === 'clean') return row.confirmedCount ? `clean; ${row.confirmedCount} reported` : 'clean; none reported'
  return row.planted
    .map((id) => {
      if (row.found.some((f) => f.id === id)) return `${id} ✓`
      if (row.wronglyRefuted.some((w) => w.id === id)) return `${id} refuted`
      return `${id} missed`
    })
    .join(', ')
}

const othersCell = (row) => {
  const bits = []
  if (row.adjudicatedTrue.length) bits.push(`${row.adjudicatedTrue.length} true`)
  const wrong = row.adjudicatedFalse.length + row.unplanned.length
  if (wrong) bits.push(`${wrong} false${row.unplanned.length ? ` (${row.unplanned.length} unruled)` : ''}`)
  if (row.known.length) bits.push(`${row.known.length} known`)
  if (row.preexisting.length) bits.push(`${row.preexisting.length} pre-existing`)
  return bits.join(', ') || '—'
}

/**
 * One benchmark: `{ name, rows: [{ pr, result, row, spent }] }` where `row` is the
 * scorer's row and `spent` is `{ cost, elapsedMs, calls }`.
 */
export function renderTable(bench, { cost = false } = {}) {
  const runners = bench.rows.map((r) => r.result.runner).filter(Boolean)
  const head = runners.length
    ? `${runners[0].agent} agents on ${[...new Set(runners.map((r) => r.model))].join(', ')} (${runners[0].cliVersion ?? 'CLI version unknown'}, ${runners[0].jobs} at once)`
    : 'plugin path'
  const out = [`**${bench.name}**: ${head}`, '', `| PR | Planted | Other confirmed findings | Agents | Calls | Minutes |${cost ? ' Cost |' : ''}`, `| :- | :- | :- | -: | -: | -: |${cost ? ' :- |' : ''}`]
  for (const { pr, result, row, spent } of bench.rows) {
    if (!row || row.note) {
      out.push(`| #${pr} | ${row?.note ?? 'not scored'} | | | | |${cost ? ' |' : ''}`)
      continue
    }
    const status = result.status === 'complete' ? '' : ` (${result.status ?? 'status unknown'})`
    out.push(`| #${pr}${status} | ${plantedCell(row)} | ${othersCell(row)} | ${result.budget?.used ?? '—'} | ${spent.calls ?? '—'} | ${minutes(spent.elapsedMs)} |${cost ? ` ${costCell(spent.cost)} |` : ''}`)
  }
  return out.join('\n')
}

/** Load one results directory into what `renderTable` takes. */
export function loadBench({ resultsDir, manifest, window = 5 }) {
  const files = readdirSync(resultsDir).filter((f) => /^pr-\d+\.json$/.test(f))
  const results = files.map((f) => ({ pr: Number(f.match(/\d+/)[0]), result: JSON.parse(readFileSync(path.join(resultsDir, f), 'utf8')) }))
  const { rows } = score({ manifest, results, window })
  const logsDir = path.join(resultsDir, 'logs')
  const entries = results
    .sort((a, b) => a.pr - b.pr)
    .map(({ pr, result }) => {
      const runner = result.runner
      const spent = runner
        ? { cost: runner.cost ?? null, elapsedMs: runner.elapsedMs ?? null, calls: Array.isArray(runner.calls) ? runner.calls.length : null }
        : { ...(existsSync(logsDir) ? fromLogs({ pr, logsDir }) : { cost: null, elapsedMs: null }), calls: null }
      return { pr, result, row: rows.find((r) => r.pr === pr) ?? null, spent }
    })
  return { name: path.basename(resultsDir), rows: entries }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const values = (name) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] !== undefined ? [argv[i + 1]] : []))
  const manifest = JSON.parse(readFileSync(values('manifest')[0] ?? path.join(here, 'manifest.json'), 'utf8'))
  const dirs = values('results')
  if (!dirs.length) {
    console.error('usage: node calibration/bench-table.mjs --results <dir> [--results <dir>…] [--manifest <file>] [--cost]')
    process.exit(2)
  }
  const cost = argv.includes('--cost')
  console.log(dirs.map((dir) => renderTable(loadBench({ resultsDir: dir, manifest }), { cost })).join('\n\n'))
}
