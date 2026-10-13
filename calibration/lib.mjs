// Score adv-review results against the planted-defect manifest. Pure: no
// filesystem, no network. `score.mjs` is the command around it.
//
// A finding matches a planted defect when one of the finding's sites is in the
// same file as one of the defect's sites and within `window` lines of it.

const near = (site, defectSite, window) => {
  if (site.file !== defectSite.file) return false
  const [lo, hi] = defectSite.lines
  return site.line >= lo - window && site.line <= hi + window
}
const sitesOf = (f) => (Array.isArray(f.sites) && f.sites.length ? f.sites : [{ file: f.file, line: f.line }])
const matches = (f, entry, window) => sitesOf(f).some((s) => entry.sites.some((d) => near(s, d, window)))
const label = (f) => `${f.file}:${f.line} ${f.title} [${f.severity}]`

/**
 * @param manifest  { repository, defects: [{ id, pr, angle, severity, sites: [{ file, lines: [lo, hi] }] }], clean: [{ pr }], known: [{ id, sites }] }
 * @param results   [{ pr, result }] — each `result` is what the review's --out wrote
 * @param heads     { [pr]: headSha } — the PRs' current heads, when known; a result for another commit is skipped
 */
export function score({ manifest, results, heads = {}, window = 5 }) {
  const rows = []
  const totals = { reviewed: 0, planted: 0, found: 0, wronglyRefuted: 0, missed: 0, confirmed: 0, plantedMatched: 0, preexisting: 0, known: 0, adjudicatedTrue: 0, adjudicatedFalse: 0, unplanned: 0 }
  const byAngle = {}
  for (const { pr, result } of [...results].sort((a, b) => a.pr - b.pr)) {
    const defects = manifest.defects.filter((d) => d.pr === pr)
    const clean = (manifest.clean ?? []).some((c) => c.pr === pr)
    if (!defects.length && !clean) {
      rows.push({ pr, note: 'not in the manifest — skipped' })
      continue
    }
    const head = heads[pr]
    if (head && result.headSha && !(head.startsWith(result.headSha) || result.headSha.startsWith(head))) {
      rows.push({ pr, note: `stale: reviewed ${result.headSha.slice(0, 7)}, the PR is at ${head.slice(0, 7)} — skipped` })
      continue
    }
    const confirmed = result.confirmed ?? []
    const refuted = result.refuted ?? []
    const found = []
    const wronglyRefuted = []
    const missed = []
    for (const d of defects) {
      const hit = confirmed.find((f) => matches(f, d, window))
      if (hit) {
        found.push({ id: d.id, foundBy: hit.foundBy ?? [], severity: hit.severity, verdict: hit.verdict ?? null })
        continue
      }
      const ref = refuted.find((f) => matches(f, d, window))
      if (ref) wronglyRefuted.push({ id: d.id, foundBy: ref.foundBy ?? [], dismissedAsUnsure: ref.dismissedAsUnsure === true, reason: ref.reason ?? ref.why ?? null })
      else missed.push(d.id)
    }
    const preexisting = []
    const known = []
    const adjudicatedTrue = []
    const adjudicatedFalse = []
    const unplanned = []
    let plantedMatched = 0
    for (const f of confirmed) {
      if (defects.some((d) => matches(f, d, window))) {
        plantedMatched += 1
        continue
      }
      if (f.preexisting === true) {
        preexisting.push(label(f))
        continue
      }
      if ((manifest.known ?? []).some((k) => matches(f, k, window))) {
        known.push(label(f))
        continue
      }
      const adj = (manifest.adjudicated ?? []).find((a) => a.pr === pr && matches(f, a, window))
      if (!adj) unplanned.push(label(f))
      else if (adj.truth === true) adjudicatedTrue.push(label(f))
      else adjudicatedFalse.push(label(f))
    }
    for (const d of defects) {
      const a = (byAngle[d.angle] ??= { planted: 0, found: 0 })
      a.planted += 1
      if (found.some((x) => x.id === d.id)) a.found += 1
    }
    totals.reviewed += 1
    totals.planted += defects.length
    totals.found += found.length
    totals.wronglyRefuted += wronglyRefuted.length
    totals.missed += missed.length
    totals.confirmed += confirmed.length
    totals.preexisting += preexisting.length
    totals.known += known.length
    totals.plantedMatched += plantedMatched
    totals.adjudicatedTrue += adjudicatedTrue.length
    totals.adjudicatedFalse += adjudicatedFalse.length
    totals.unplanned += unplanned.length
    rows.push({
      pr,
      kind: clean ? 'clean' : 'planted',
      status: result.status ?? null,
      agents: result.budget?.used ?? null,
      planted: defects.map((d) => d.id),
      found,
      wronglyRefuted,
      missed,
      plantedMatched,
      preexisting,
      known,
      adjudicatedTrue,
      adjudicatedFalse,
      unplanned,
    })
  }
  // Precision is over confirmed findings that are not pre-existing. A finding
  // nobody has adjudicated counts against it: unknown is not true.
  const judged = totals.confirmed - totals.preexisting
  const falsePositives = totals.unplanned + totals.adjudicatedFalse
  const summary = {
    ...totals,
    recall: totals.planted ? totals.found / totals.planted : null,
    precision: judged ? (judged - falsePositives) / judged : null,
    byAngle,
  }
  return { rows, summary }
}

const pct = (x) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`)

/** The report as text, one block per PR and the totals. */
export function format({ rows, summary }) {
  const out = []
  for (const r of rows) {
    if (r.note) {
      out.push(`PR #${r.pr}: ${r.note}`)
      continue
    }
    out.push(`PR #${r.pr} (${r.kind}, ${r.status ?? 'status unknown'}, ${r.agents ?? '?'} agents)`)
    if (r.planted.length) {
      const bits = [`found ${r.found.map((f) => `${f.id} by ${f.foundBy.join('+') || '?'}`).join(', ') || '—'}`]
      if (r.wronglyRefuted.length) bits.push(`WRONGLY REFUTED ${r.wronglyRefuted.map((w) => `${w.id}${w.dismissedAsUnsure ? ' (only for doubt)' : ''}`).join(', ')}`)
      if (r.missed.length) bits.push(`MISSED ${r.missed.join(', ')}`)
      out.push(`  planted ${r.planted.join(', ')} → ${bits.join('; ')}`)
    }
    if (r.unplanned.length) out.push(`  to adjudicate: ${r.unplanned.join(' | ')}`)
    if (r.adjudicatedTrue.length) out.push(`  true, unplanted: ${r.adjudicatedTrue.join(' | ')}`)
    if (r.adjudicatedFalse.length) out.push(`  FALSE POSITIVE: ${r.adjudicatedFalse.join(' | ')}`)
    if (r.known.length) out.push(`  known: ${r.known.join(' | ')}`)
    if (r.preexisting.length) out.push(`  pre-existing: ${r.preexisting.join(' | ')}`)
  }
  const s = summary
  const judged = s.confirmed - s.preexisting
  out.push('')
  out.push(`recall ${pct(s.recall)}: ${s.found} of ${s.planted} planted defects confirmed (${s.wronglyRefuted} found then wrongly refuted, ${s.missed} missed) across ${s.reviewed} PRs`)
  out.push(`precision ${pct(s.precision)}: ${judged - s.unplanned - s.adjudicatedFalse} of ${judged} confirmed findings true (${s.plantedMatched} on planted defects, ${s.known} known, ${s.adjudicatedTrue} adjudicated true); ${s.adjudicatedFalse} adjudicated false; ${s.unplanned} to adjudicate, counted false; ${s.preexisting} pre-existing left out`)
  const angles = Object.entries(s.byAngle)
  if (angles.length) out.push(`by angle: ${angles.map(([a, v]) => `${a} ${v.found}/${v.planted}`).join(', ')}`)
  return out.join('\n')
}
