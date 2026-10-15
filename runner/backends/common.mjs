// Shared by the backends: pulling a JSON object out of model text, token
// accounting, and the instruction a CLI that cannot enforce a schema gets.
import { describe } from '../schema.mjs'

/** The first complete JSON object in `text`, fences and prose ignored, or null. */
export function extractJson(text) {
  if (typeof text !== 'string') return null
  const stripped = text.replace(/```(?:json)?/gi, '')
  for (let start = stripped.indexOf('{'); start >= 0; start = stripped.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    for (let i = start; i < stripped.length; i++) {
      const c = stripped[i]
      if (inString) {
        if (c === '\\') i++
        else if (c === '"') inString = false
        continue
      }
      if (c === '"') inString = true
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(stripped.slice(start, i + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  return null
}

/** The last JSON object printed on stdout (a CLI's result document), or null. */
export function lastJsonObject(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {}
  const lines = trimmed.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {}
  }
  return extractJson(trimmed)
}

/** What a model is told when the CLI cannot enforce the schema itself. */
export const schemaNote = (schema) =>
  `Answer with ONLY one JSON object matching this schema, no prose and no code fence: ${describe(schema)}\nThe schema in full:\n${JSON.stringify(schema)}`

export const tail = (s, n = 400) => String(s ?? '').trim().slice(-n)
