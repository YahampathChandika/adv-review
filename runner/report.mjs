// The report, the result file, and the pull request comment.
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defaultExec } from './worktree.mjs'

const SEV = { critical: 0, high: 1, medium: 2, low: 3 }
const bySeverity = (a, b) => (SEV[a.severity] ?? 9) - (SEV[b.severity] ?? 9)
const where = (f) => `${f.file}:${f.line}`
const sitesNote = (f) => (f.sites && f.sites.length > 1 ? ` (${f.sites.length} sites)` : '')

const findingLines = (list, { failure = true } = {}) =>
  [...list].sort(bySeverity).flatMap((f) => {
    const head = `- [${String(f.severity).toUpperCase()}] ${where(f)}${sitesNote(f)} ${f.title}${f.verdict === 'PLAUSIBLE' ? ' (plausible)' : ''}${f.corrected ? ' (corrected)' : ''}`
    const lines = [head, `  ${f.summary ?? ''}`]
    if (failure && f.failure) lines.push(`  failure: ${f.failure}`)
    return lines
  })

/** The human report, for the terminal. */
export function renderReport(result, runner = result.runner) {
  const out = []
  const target = result.target?.prs ? `PR${result.target.prs.length > 1 ? 's' : ''} ${result.target.prs.map((n) => `#${n}`).join(', ')}` : `branch ${result.target?.branch} against ${result.target?.base}`
  out.push(`adv-review: ${target} at ${String(result.headSha).slice(0, 8)} — ${result.status.toUpperCase()}`)
  if (result.status === 'incomplete') {
    out.push('INCOMPLETE:')
    for (const r of result.incomplete) out.push(`- ${r}`)
    out.push('')
  }
  const introduced = (result.confirmed ?? []).filter((f) => !f.preexisting)
  const preexisting = (result.confirmed ?? []).filter((f) => f.preexisting)
  out.push(introduced.length ? `Confirmed (${introduced.length}):` : 'Confirmed: none.')
  out.push(...findingLines(introduced))
  if (preexisting.length) {
    out.push('', `Pre-existing, not this change's doing (${preexisting.length}):`)
    out.push(...findingLines(preexisting))
  }
  if (result.unverified?.length) {
    out.push('', `UNVERIFIED (${result.unverified.length}), for a person to check:`)
    out.push(...findingLines(result.unverified, { failure: false }))
  }
  if (result.refuted?.length) {
    out.push('', `Refuted (${result.refuted.length}):`)
    for (const f of [...result.refuted].sort(bySeverity)) out.push(`- ${where(f)} ${f.title}${f.dismissedAsUnsure ? ' (dismissed for doubt alone)' : ''}: ${f.why ?? ''}`)
  }
  if (result.missed === null) out.push('', 'Coverage: unknown — the critic did not run.')
  else if (result.missed?.length) {
    out.push('', `The critic names ${result.missed.length} gap(s), unverified:`)
    for (const g of result.missed) out.push(`- ${g.what}`)
  }
  const b = result.budget ?? {}
  out.push('', `Agents: ${b.used} of ${b.ceiling} — 1 scout, ${b.finders} finder(s), ${b.triage} triage, ${b.sameSite ?? 0} same-site, ${b.skeptics} skeptic(s), ${b.critic} critic${b.retries ? `, ${b.retries} retried` : ''}.`)
  if (result.angles) out.push(`Angles: ${result.angles.map((a) => a.title).join(', ')}${result.droppedAngles?.length ? `; dropped ${result.droppedAngles.map((a) => a.title).join(', ')}` : ''}${result.notRun?.length ? `; NOT RUN ${result.notRun.join(', ')}` : ''}.`)
  if (runner) {
    const cost = runner.cost ?? {}
    const money = typeof cost.usd === 'number' ? ` $${cost.usd.toFixed(2)}` : cost.inputTokens ? ` ${cost.inputTokens + cost.outputTokens} tokens` : ''
    out.push(`Runner: ${runner.agent} (${runner.model ?? 'cli-default'}${runner.cliVersion ? `, ${runner.cliVersion}` : ''}), ${runner.calls?.length ?? 0} call(s), ${Math.round((runner.elapsedMs ?? 0) / 60_000)} min${money}.`)
  }
  return out.join('\n')
}

/** The pull request comment: pre-existing findings left out unless asked. */
export function renderComment(result, { includePreexisting = false } = {}) {
  const out = [`## adv-review of ${String(result.headSha).slice(0, 8)}`, '']
  if (result.status === 'incomplete') out.push(`**Incomplete:** ${result.incomplete.join('; ')}`, '')
  const shown = (result.confirmed ?? []).filter((f) => includePreexisting || !f.preexisting)
  out.push(shown.length ? `**Confirmed (${shown.length})**` : '**Confirmed:** none.')
  for (const f of [...shown].sort(bySeverity)) {
    out.push(`- **${String(f.severity).toUpperCase()}** \`${where(f)}\`${sitesNote(f)} ${f.title}${f.preexisting ? ' *(pre-existing)*' : ''}${f.verdict === 'PLAUSIBLE' ? ' *(plausible)*' : ''}: ${f.summary ?? ''}`)
    if (f.failure) out.push(`  - failure: ${f.failure}`)
  }
  if (result.unverified?.length) {
    out.push('', `**Unverified (${result.unverified.length})**, not confirmed and not refuted:`)
    for (const f of result.unverified) out.push(`- \`${where(f)}\` ${f.title}`)
  }
  if (result.missed?.length) {
    out.push('', `**Possible gaps the critic named**, unverified:`)
    for (const g of result.missed) out.push(`- ${g.what}`)
  }
  const b = result.budget ?? {}
  out.push('', `<sub>${b.used} of ${b.ceiling} agents; ${result.counts?.refuted ?? 0} refuted; runner ${result.runner?.agent ?? ''} ${result.runner?.model ?? ''}</sub>`)
  return out.join('\n')
}

export async function writeOut(file, result) {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true })
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`)
}

export async function postComment({ pr, body, repo, exec = defaultExec }) {
  const file = path.join(os.tmpdir(), `adv-review-comment-${process.pid}-${pr}.md`)
  await writeFile(file, body)
  await exec('gh', ['pr', 'comment', String(pr), '--body-file', file], { cwd: repo })
}
