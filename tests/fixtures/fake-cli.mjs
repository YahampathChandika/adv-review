// A stand-in for the claude, codex and gemini CLIs, for the runner's tests: it
// answers by the label the engine put in ADV_REVIEW_LABEL, in the output shape
// of the CLI named by ADV_REVIEW_FAKE_MODE, and logs each invocation.
//
//   ADV_REVIEW_FAKE_MODE    claude | codex | gemini (default claude)
//   ADV_REVIEW_FAKE_SCRIPT  JSON file: { "<label or kind>": answer | [answer per attempt] }
//                           an answer may carry __exitCode, __sleepMs, __text (raw output instead of JSON)
//   ADV_REVIEW_FAKE_LOG     JSONL file to append { pid, label, attempt, argv, cwd, start, end } to
//   ADV_REVIEW_FAKE_SLEEP_MS  sleep before answering (every call)
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const env = process.env
const mode = env.ADV_REVIEW_FAKE_MODE ?? 'claude'
const label = env.ADV_REVIEW_LABEL ?? ''
const kind = label.split(':')[0]
const attempt = Number(env.ADV_REVIEW_ATTEMPT ?? 1)
const start = Date.now()

const after = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}
const prompt = mode === 'codex' ? argv[argv.indexOf('exec') + 1] : after('-p')
const claimsIn = (text) => (String(text ?? '').match(/^\[\d+\] (CRITICAL|HIGH|MEDIUM|LOW) — /gm) ?? []).length

const sleepMs = Number(env.ADV_REVIEW_FAKE_SLEEP_MS ?? 0)
if (sleepMs) execFileSync(process.execPath, ['-e', `setTimeout(() => {}, ${sleepMs})`])

let answer
const script = env.ADV_REVIEW_FAKE_SCRIPT ? JSON.parse(readFileSync(env.ADV_REVIEW_FAKE_SCRIPT, 'utf8')) : {}
const chosen = script[label] ?? script[kind]
if (chosen !== undefined) answer = Array.isArray(chosen) ? (chosen[attempt - 1] ?? chosen[chosen.length - 1]) : chosen
else if (kind === 'scout') answer = { drop: [], add: [] }
else if (kind === 'find') answer = { findings: [] }
else if (kind === 'triage') answer = { clusters: [] }
else if (kind === 'same-site') answer = { merges: [] }
else if (kind === 'refute') answer = { verdicts: Array.from({ length: claimsIn(prompt) }, (_, index) => ({ index, refuted: false, confidence: 'certain', reasoning: 'could not refute' })) }
else if (kind === 'critic') answer = { gaps: [] }
else answer = {}

if (answer && typeof answer === 'object' && answer.__sleepMs) execFileSync(process.execPath, ['-e', `setTimeout(() => {}, ${answer.__sleepMs})`])

const finish = (code) => {
  if (env.ADV_REVIEW_FAKE_LOG) appendFileSync(env.ADV_REVIEW_FAKE_LOG, `${JSON.stringify({ pid: process.pid, label, attempt, argv, cwd: process.cwd(), start, end: Date.now() })}\n`)
  process.exit(code)
}

if (answer && typeof answer === 'object' && typeof answer.__exitCode === 'number') {
  process.stderr.write(answer.__stderr ?? 'fake failure\n')
  finish(answer.__exitCode)
}

const rawText = answer && typeof answer === 'object' && typeof answer.__text === 'string' ? answer.__text : null
let doc = answer
if (!rawText && doc && typeof doc === 'object' && kind !== 'triage' && doc.reviewedCommit === undefined && !doc.__noCommit) {
  let head = ''
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {}
  doc = { ...doc, reviewedCommit: head }
}
if (doc && typeof doc === 'object') {
  for (const key of Object.keys(doc)) if (key.startsWith('__')) delete doc[key]
}
const text = rawText ?? JSON.stringify(doc)

if (mode === 'claude') {
  const structured = rawText ? undefined : doc
  process.stdout.write(
    `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: text,
      structured_output: structured,
      total_cost_usd: 0.01,
      num_turns: 3,
      duration_ms: 10,
      modelUsage: { 'fake-claude': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5 } },
    })}\n`,
  )
} else if (mode === 'codex') {
  const out = after('-o')
  if (out) writeFileSync(out, text)
  for (const e of [
    { type: 'thread.started', thread_id: 't1', model: 'fake-codex' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } },
  ]) {
    process.stdout.write(`${JSON.stringify(e)}\n`)
  }
} else {
  process.stdout.write(`${JSON.stringify({ response: `Here you go:\n\`\`\`json\n${text}\n\`\`\``, stats: { models: { 'fake-gemini': { tokens: { input: 100, output: 20 } } } } })}\n`)
}
finish(0)
