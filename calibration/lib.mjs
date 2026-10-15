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
 * @param manifest  { repository, defects: [{ id, pr, set, angle, severity, sites: [{ file, lines: [lo, hi] }] }], clean: [{ pr, set }], known: [{ id, sites }], adjudicated: [{ pr, truth, sites }] }
 * @param results   [{ pr, result }] — each `result` is what the review's --out wrote
 * @param heads     { [pr]: headSha } — the PRs' current heads, when known; a result for another commit is skipped
 * @param sets      only score PRs in these sets (an entry without a set is in 'v1'); all when omitted
 */
export function score({ manifest, results, heads = {}, window = 5, sets = null }) {
  const rows = []
  const entryOf = (pr) => manifest.defects.find((d) => d.pr === pr) ?? (manifest.clean ?? []).find((c) => c.pr === pr)
  for (const { pr, result } of [...results].sort((a, b) => a.pr - b.pr)) {
    const defects = manifest.defects.filter((d) => d.pr === pr)
    const clean = (manifest.clean ?? []).some((c) => c.pr === pr)
    if (!defects.length && !clean) {
      rows.push({ pr, note: 'not in the manifest — skipped' })
      continue
    }
    const set = entryOf(pr).set ?? 'v1'
    if (sets && !sets.includes(set)) continue
    const head = heads[pr]
    if (head && result.headSha && !(head.startsWith(result.headSha) || result.headSha.startsWith(head))) {
      rows.push({ pr, note: `stale: reviewed ${result.headSha.slice(0, 7)}, the PR is at ${head.slice(0, 7)} — skipped` })
      continue
    }
    const confirmed = result.confirmed ?? []
    const refuted = result.refuted ?? []
    // A person's ruling on a finding's own site outranks a site overlap: a
    // grouped finding may list a planted line among its sites and still be
    // about something else. A ruled finding counts for neither recall nor
    // a planted match.
    // A ruling whose lines contain the finding's own line outranks one that only
    // sits within the window: two findings a few lines apart may deserve
    // different rulings.
    const contains = (s, f) => s.file === f.file && f.line >= s.lines[0] && f.line <= s.lines[1]
    const rulingOn = (f) => {
      const rulings = (manifest.adjudicated ?? []).filter((a) => a.pr === pr)
      return rulings.find((a) => a.sites.some((s) => contains(s, f))) ?? rulings.find((a) => a.sites.some((s) => near({ file: f.file, line: f.line }, s, window)))
    }
    const unruled = confirmed.filter((f) => !rulingOn(f))
    const found = []
    const wronglyRefuted = []
    const missed = []
    for (const d of defects) {
      const hit = unruled.find((f) => matches(f, d, window))
      if (hit) {
        found.push({ id: d.id, foundBy: hit.foundBy ?? [], severity: hit.severity, verdict: hit.verdict ?? null })
        continue
      }
      const ref = refuted.find((f) => matches(f, d, window))
      if (ref) wronglyRefuted.push({ id: d.id, foundBy: ref.foundBy ?? [], dismissedAsUnsure: ref.dismissedAsUnsure === true, reason: ref.reason ?? ref.why ?? null })
      else missed.push(d.id)
    }
    // A missed defect the critic named among its gaps was seen but never verified.
    // Gaps are free text, so the test is a mention of one of the defect's files:
    // reported for a person to read, never counted as found.
    const gaps = Array.isArray(result.missed) ? result.missed : []
    const surfacedByCritic = missed.filter((id) => {
      const files = defects.find((d) => d.id === id).sites.map((x) => x.file)
      return gaps.some((g) => files.some((file) => `${g.what ?? ''} ${g.why ?? ''}`.includes(file)))
    })
    const preexisting = []
    const known = []
    const adjudicatedTrue = []
    const adjudicatedFalse = []
    const unplanned = []
    let plantedMatched = 0
    for (const f of confirmed) {
      const ruled = rulingOn(f)
      if (ruled) {
        if (ruled.truth === true) adjudicatedTrue.push(label(f))
        else adjudicatedFalse.push(label(f))
        continue
      }
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
      unplanned.push(label(f))
    }
    rows.push({
      pr,
      set,
      kind: clean ? 'clean' : 'planted',
      status: result.status ?? null,
      agents: result.budget?.used ?? null,
      planted: defects.map((d) => d.id),
      plantedAngles: defects.map((d) => ({ id: d.id, angle: d.angle })),
      confirmedCount: confirmed.length,
      found,
      wronglyRefuted,
      missed,
      surfacedByCritic,
      plantedMatched,
      preexisting,
      known,
      adjudicatedTrue,
      adjudicatedFalse,
      unplanned,
    })
  }
  const setNames = [...new Set(rows.filter((r) => !r.note).map((r) => r.set))].sort()
  const bySet = Object.fromEntries(setNames.map((name) => [name, summarise(rows.filter((r) => r.set === name))]))
  return { rows, summary: { ...summarise(rows), bySet } }
}

/** Totals, recall, precision and recall by angle over scored rows. */
function summarise(rows) {
  const scored = rows.filter((r) => !r.note)
  const sum = (f) => scored.reduce((n, r) => n + f(r), 0)
  const totals = {
    reviewed: scored.length,
    planted: sum((r) => r.planted.length),
    found: sum((r) => r.found.length),
    wronglyRefuted: sum((r) => r.wronglyRefuted.length),
    missed: sum((r) => r.missed.length),
    surfacedByCritic: sum((r) => r.surfacedByCritic.length),
    confirmed: sum((r) => r.confirmedCount),
    plantedMatched: sum((r) => r.plantedMatched),
    preexisting: sum((r) => r.preexisting.length),
    known: sum((r) => r.known.length),
    adjudicatedTrue: sum((r) => r.adjudicatedTrue.length),
    adjudicatedFalse: sum((r) => r.adjudicatedFalse.length),
    unplanned: sum((r) => r.unplanned.length),
  }
  const byAngle = {}
  for (const r of scored) {
    for (const d of r.plantedAngles) {
      const a = (byAngle[d.angle] ??= { planted: 0, found: 0 })
      a.planted += 1
      if (r.found.some((x) => x.id === d.id)) a.found += 1
    }
  }
  // Precision is over confirmed findings that are not pre-existing. A finding
  // nobody has adjudicated counts against it: unknown is not true.
  const judged = totals.confirmed - totals.preexisting
  const falsePositives = totals.unplanned + totals.adjudicatedFalse
  return {
    ...totals,
    recall: totals.planted ? totals.found / totals.planted : null,
    precision: judged ? (judged - falsePositives) / judged : null,
    byAngle,
  }
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
      if (r.missed.length) bits.push(`MISSED ${r.missed.map((id) => (r.surfacedByCritic.includes(id) ? `${id} (named by the critic, unverified)` : id)).join(', ')}`)
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
  out.push(`recall ${pct(s.recall)}: ${s.found} of ${s.planted} planted defects confirmed (${s.wronglyRefuted} found then wrongly refuted, ${s.missed} missed${s.surfacedByCritic ? `, ${s.surfacedByCritic} of them named by the critic` : ''}) across ${s.reviewed} PRs`)
  out.push(`precision ${pct(s.precision)}: ${judged - s.unplanned - s.adjudicatedFalse} of ${judged} confirmed findings true (${s.plantedMatched} on planted defects, ${s.known} known, ${s.adjudicatedTrue} adjudicated true); ${s.adjudicatedFalse} adjudicated false; ${s.unplanned} to adjudicate, counted false; ${s.preexisting} pre-existing left out`)
  const angles = Object.entries(s.byAngle)
  if (angles.length) out.push(`by angle: ${angles.map(([a, v]) => `${a} ${v.found}/${v.planted}`).join(', ')}`)
  const setNames = Object.keys(s.bySet ?? {})
  if (setNames.length > 1) {
    for (const name of setNames) {
      const t = s.bySet[name]
      const j = t.confirmed - t.preexisting
      out.push(`set ${name}: recall ${pct(t.recall)} (${t.found} of ${t.planted}), precision ${pct(t.precision)} (${j - t.unplanned - t.adjudicatedFalse} of ${j}) across ${t.reviewed} PRs`)
    }
  }
  return out.join('\n')
}
