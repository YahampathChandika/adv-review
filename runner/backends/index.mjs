import * as claude from './claude.mjs'
import * as codex from './codex.mjs'
import * as copilot from './copilot.mjs'
import * as gemini from './gemini.mjs'

export const BACKENDS = { claude, codex, gemini, copilot }
export const AGENTS = Object.keys(BACKENDS)

export function backendFor(agent) {
  const b = BACKENDS[agent]
  if (!b) throw new Error(`unknown agent "${agent}"; one of ${AGENTS.join(', ')}`)
  return b
}
