#!/usr/bin/env node
// Score recorded adv-review results against the planted-defect manifest.
//
//   node calibration/score.mjs [--results calibration/results] [--manifest calibration/manifest.json]
//                              [--window 5] [--min-recall 0.7] [--offline] [--json]
//
// A result file is what `/adv-review:review <n> --out …` wrote, named
// `pr-<n>.json`. Unless --offline, each PR's current head is read with `gh`
// and a result for another commit is skipped, so stale results never count.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { format, score } from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const manifestPath = opt('manifest', path.join(here, 'manifest.json'))
const resultsDir = opt('results', path.join(here, 'results'))
const window = Number(opt('window', 5))
const minRecall = opt('min-recall', null)

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
let files = []
try {
  files = readdirSync(resultsDir).filter((f) => /^pr-\d+\.json$/.test(f))
} catch {}
if (!files.length) {
  console.error(`no pr-<n>.json results under ${resultsDir}`)
  process.exit(1)
}
const results = files.map((f) => ({ pr: Number(f.match(/\d+/)[0]), result: JSON.parse(readFileSync(path.join(resultsDir, f), 'utf8')) }))

const heads = {}
if (!flag('offline')) {
  for (const { pr } of results) {
    try {
      heads[pr] = execFileSync('gh', ['pr', 'view', String(pr), '-R', manifest.repository, '--json', 'headRefOid', '-q', '.headRefOid'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      console.error(`could not read PR #${pr}'s head with gh; pass --offline to skip the check`)
      process.exit(1)
    }
  }
}

const scored = score({ manifest, results, heads, window })
console.log(flag('json') ? JSON.stringify(scored, null, 2) : format(scored))
if (minRecall !== null && scored.summary.recall !== null && scored.summary.recall < Number(minRecall)) {
  console.error(`recall ${scored.summary.recall.toFixed(2)} is below ${minRecall}`)
  process.exit(1)
}
