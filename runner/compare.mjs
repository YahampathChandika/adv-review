#!/usr/bin/env node
// Reviews of one commit by different agents, side by side: what every agent
// found, what only some did, what one confirmed and another refuted, and the
// agents, minutes and cost of each run. A real pull request has no answer key,
// so which agent is right about a finding is still a person's call.
//
//   node runner/compare.mjs <result.json> <result.json>... [--window 5] [--json]
//
// Each file is what `runner/review.mjs --out` (or the skill's `--out`) wrote.
// Two findings count as one when they sit within `window` lines of each other
// in one file AND their titles share at least half their words: agents word a
// defect differently, but one line can also carry two different defects.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export class CompareError extends Error {}

const SEV = { critical: 0, high: 1, medium: 2, low: 3 }
const bySeverity = (a, b) => (SEV[a.severity] ?? 9) - (SEV[b.severity] ?? 9)
const sitesOf = (f) => (Array.isArray(f.sites) && f.sites.length ? f.sites : [{ file: f.file, line: f.line }])

/** Two findings are about one place when any site of one is within `window` lines of any site of the other, in the same file. */
export const sameSite = (a, b, window) => sitesOf(a).some((x) => sitesOf(b).some((y) => x.file === y.file && Math.abs(Number(x.line) - Number(y.line)) <= window))

const STOP = new Set('a an the of in on to is are be by for with and or not no all any its it can when under from that this as at into than then so if only also one two each every after before over per via through out up down about across between both same more most less other another some such own new old has have had was were will would should could may might does do did done there here their they them we you our your his her him she he who which what where why how still yet even ever never now just very'.split(' '))
const singular = (w) => (w.length >= 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)
/** The content words of a title: lower-case, without stop words, plurals folded. */
export const words = (text) => [...new Set(String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map(singular))]
// One word stands for another when equal, or when one is the other's prefix (save/saved, name/named, local/locally).
const stands = (x, y) => x === y || (x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x)))

/** How far two findings read as one: the share of the shorter title's content words the other title carries. */
export const similarity = (a, b) => {
  const x = words(a.title)
  const y = words(b.title)
  if (!x.length || !y.length) return 1
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return short.filter((w) => long.some((v) => stands(w, v))).length / short.length
}
export const similar = (a, b) => similarity(a, b) >= 0.5
const sameFinding = (a, b, window) => sameSite(a, b, window) && similar(a, b)

/** A name per review, from its runner's agent; two runs of one agent are told apart by model, then by number. */
export function labelReviews(entries) {
  const base = entries.map((e, i) => e.result.runner?.agent ?? path.basename(e.file ?? `review-${i + 1}`, '.json'))
  const withModel = base.map((name, i) => (base.filter((n) => n === name).length > 1 && entries[i].result.runner?.model ? `${name} ${entries[i].result.runner.model}` : name))
  const seen = {}
  return withModel.map((name) => {
    seen[name] = (seen[name] ?? 0) + 1
    return seen[name] > 1 ? `${name} #${seen[name]}` : name
  })
}

/**
 * `reviews`: [{ name, result }], all of one commit. Returns
 * `{ target, headSha, runs, groups }`, where a group is one place in the code
 * with the finding each agent made there, `by` (the agents that confirmed one)
 * and `refutedBy` (the agents that refuted one).
 */
export function compare(reviews, { window = 5 } = {}) {
  if (reviews.length < 2) throw new CompareError('give at least two result files to compare')
  const heads = [...new Set(reviews.map((r) => r.result.headSha ?? '(no commit recorded)'))]
  if (heads.length > 1) throw new CompareError(`the reviews are of different commits (${heads.map((h) => h.slice(0, 8)).join(', ')}); compare reviews of one commit`)
  const groups = []
  const groupOf = new Map()
  for (const { name, result } of reviews) {
    for (const f of result.confirmed ?? []) {
      // The best-matching group this agent is not in yet, if any reads as the same finding.
      const g = groups
        .filter((g) => !g.by.includes(name) && Object.values(g.findings).some((x) => sameSite(x, f, window)))
        .map((g) => ({ g, s: Math.max(...Object.values(g.findings).map((x) => (sameSite(x, f, window) ? similarity(x, f) : 0))) }))
        .filter(({ s }) => s >= 0.5)
        .sort((p, q) => q.s - p.s)[0]?.g
      if (g) {
        g.by.push(name)
        g.findings[name] = f
        if ((SEV[f.severity] ?? 9) < (SEV[g.severity] ?? 9)) g.severity = f.severity
        if (f.preexisting === true) g.preexisting = true
        groupOf.set(f, g)
      } else {
        const fresh = { file: f.file, line: f.line, title: f.title, severity: f.severity, preexisting: f.preexisting === true, by: [name], findings: { [name]: f }, refutedBy: [], alsoHere: [] }
        groups.push(fresh)
        groupOf.set(f, fresh)
      }
    }
  }
  for (const { name, result } of reviews) {
    for (const f of result.refuted ?? []) {
      for (const g of groups) {
        if (!g.by.includes(name) && !g.refutedBy.includes(name) && Object.values(g.findings).some((x) => sameFinding(x, f, window))) g.refutedBy.push(name)
      }
    }
  }
  // An agent that found something else at the same place is named, with its
  // finding, when that finding is not already paired with one of this group's
  // agents: the two wordings may be one defect after all, or one line two defects.
  for (const g of groups) {
    for (const { name, result } of reviews) {
      if (g.by.includes(name)) continue
      for (const f of result.confirmed ?? []) {
        const h = groupOf.get(f)
        if (h === g || h.by.some((n) => g.by.includes(n))) continue
        if (Object.values(g.findings).some((x) => sameSite(x, f, window))) g.alsoHere.push({ name, file: f.file, line: f.line, title: f.title })
      }
    }
  }
  groups.sort(bySeverity)
  const runs = reviews.map(({ name, result }) => ({
    name,
    model: result.runner?.model ?? null,
    cliVersion: result.runner?.cliVersion ?? null,
    status: result.status ?? null,
    agents: result.budget?.used ?? null,
    elapsedMs: result.runner?.elapsedMs ?? null,
    cost: result.runner?.cost ?? null,
    confirmed: (result.confirmed ?? []).length,
    refuted: (result.refuted ?? []).length,
  }))
  return { target: reviews[0].result.target ?? null, headSha: heads[0], runs, groups }
}

const costOf = (cost) => {
  if (!cost) return '—'
  if (typeof cost.usd === 'number') return `$${cost.usd.toFixed(2)}`
  const tokens = Number(cost.inputTokens ?? 0) + Number(cost.outputTokens ?? 0)
  return tokens ? `${(tokens / 1e6).toFixed(1)}M tokens` : '—'
}
const minutes = (ms) => (typeof ms === 'number' ? `${Math.round(ms / 60_000)} min` : '—')
const targetOf = (t) => (t?.prs?.length ? `PR ${t.prs.map((n) => `#${n}`).join(', ')}` : t?.branch ? `branch ${t.branch}` : 'the same commit')
const severities = (g) => {
  const others = g.by.filter((n) => g.findings[n].severity !== g.severity).map((n) => `${n}: ${g.findings[n].severity}`)
  return others.length ? ` (${others.join(', ')})` : ''
}
const line = (g) => `  [${String(g.severity).toUpperCase()}] ${g.file}:${g.line} ${g.title}${severities(g)}${g.preexisting ? ' (pre-existing)' : ''}`

/** The comparison as text. */
export function render({ target, headSha, runs, groups }) {
  const out = [`Compared ${runs.length} reviews of ${targetOf(target)} at ${String(headSha).slice(0, 8)}:`]
  const width = Math.max(...runs.map((r) => r.name.length))
  for (const r of runs) {
    out.push(`  ${r.name.padEnd(width)}  ${r.model ?? 'model unknown'}; ${r.agents ?? '?'} agents, ${minutes(r.elapsedMs)}, ${costOf(r.cost)}; ${r.confirmed} confirmed, ${r.refuted} refuted${r.status && r.status !== 'complete' ? `; ${r.status}` : ''}`)
  }
  const all = groups.filter((g) => g.by.length === runs.length)
  const some = groups.filter((g) => g.by.length !== runs.length)
  out.push('', `Found by every agent (${all.length}):`, ...(all.length ? all.map(line) : ['  none']))
  out.push('', `Found by some (${some.length}):`)
  if (!some.length) out.push('  none')
  for (const g of some) {
    const who = `found by ${g.by.join(' and ')}${g.by.length === 1 ? ' only' : ''}`
    out.push(`${line(g)} — ${who}${g.refutedBy.length ? `; refuted by ${g.refutedBy.join(' and ')}` : ''}`)
    for (const other of g.alsoHere) out.push(`      ${other.name} found something else at this place: "${other.title}"${other.line !== g.line ? ` (${other.file}:${other.line})` : ''}`)
  }
  const disputed = groups.filter((g) => g.refutedBy.length)
  if (disputed.length) out.push('', `Confirmed by one agent and refuted by another: ${disputed.length}. A refutation is a verdict on the claim as that agent's skeptic saw it, not on the code; read both before trusting either.`)
  out.push(
    '',
    'Findings within a few lines of each other with similar titles count as one. Where another agent found',
    'something else at the same place, its finding is named underneath: that may be the same defect in other',
    "words, or two defects on one line. A real pull request has no answer key: which agent is right is a person's call.",
  )
  return out.join('\n')
}

/** The command. Returns the exit code. */
export function main(argv, { stdout = (s) => process.stdout.write(`${s}\n`), stderr = (s) => process.stderr.write(`${s}\n`), read = (f) => readFileSync(f, 'utf8') } = {}) {
  const files = []
  let window = 5
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--window') window = Number(argv[++i])
    else if (a === '--json') json = true
    else if (a === '-h' || a === '--help') {
      stdout('usage: node runner/compare.mjs <result.json> <result.json>... [--window 5] [--json]')
      return 0
    } else files.push(a)
  }
  if (!Number.isInteger(window) || window < 0) {
    stderr('error: --window must be a whole number of lines')
    return 2
  }
  try {
    const entries = files.map((file) => ({ file, result: JSON.parse(read(file)) }))
    const names = labelReviews(entries)
    const cmp = compare(entries.map((e, i) => ({ name: names[i], result: e.result })), { window })
    stdout(json ? JSON.stringify(cmp, null, 2) : render(cmp))
    return 0
  } catch (err) {
    stderr(`error: ${err instanceof CompareError ? err.message : err.message}`)
    return 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
