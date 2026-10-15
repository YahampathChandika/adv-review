// A JSON Schema subset validator: enough for the six schemas the review script
// hands its agents (type, properties, required, items, enum), with messages a
// model can act on. Extra properties are allowed, as those schemas allow them.
//
// The script reads exact JSON types — `index` must be an integer, `refuted`
// and `introducedByDiff` booleans — so "false" the string is an error here.

const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
const show = (v) => {
  const s = JSON.stringify(v)
  if (s === undefined) return String(v)
  return s.length > 60 ? `${s.slice(0, 57)}...` : s
}

/** `{ ok: true }` or `{ ok: false, errors: [...] }`, one message per problem found. */
export function validate(schema, value, path = '$') {
  const errors = []
  check(schema, value, path, errors)
  return errors.length ? { ok: false, errors } : { ok: true }
}

function check(schema, value, path, errors) {
  if (!schema || typeof schema !== 'object') return
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) errors.push(`${path}: expected one of ${schema.enum.map(show).join(', ')}, got ${show(value)}`)
    return
  }
  switch (schema.type) {
    case 'object': {
      if (typeName(value) !== 'object') {
        errors.push(`${path}: expected object, got ${typeName(value)} ${show(value)}`)
        return
      }
      for (const key of schema.required ?? []) if (value[key] === undefined) errors.push(`${path}: missing required "${key}"`)
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (value[key] !== undefined) check(sub, value[key], `${path}.${key}`, errors)
      }
      return
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array, got ${typeName(value)} ${show(value)}`)
        return
      }
      if (schema.items) value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors))
      return
    }
    case 'string':
      if (typeof value !== 'string') errors.push(`${path}: expected string, got ${typeName(value)} ${show(value)}`)
      return
    case 'integer':
      if (!Number.isInteger(value)) errors.push(`${path}: expected integer, got ${typeName(value)} ${show(value)}`)
      return
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${path}: expected number, got ${typeName(value)} ${show(value)}`)
      return
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path}: expected boolean, got ${typeName(value)} ${show(value)}`)
      return
    default:
  }
}

/** A one-line type sketch of a schema, for a prompt: `{ reviewedCommit: string, findings: [{ … }] }`. */
export function describe(schema) {
  if (!schema || typeof schema !== 'object') return 'any'
  if (Array.isArray(schema.enum)) return schema.enum.map((e) => JSON.stringify(e)).join(' | ')
  switch (schema.type) {
    case 'object': {
      const required = new Set(schema.required ?? [])
      const fields = Object.entries(schema.properties ?? {}).map(([k, s]) => `${k}${required.has(k) ? '' : '?'}: ${describe(s)}`)
      return `{ ${fields.join(', ')} }`
    }
    case 'array':
      return `[${describe(schema.items)}]`
    default:
      return schema.type ?? 'any'
  }
}
