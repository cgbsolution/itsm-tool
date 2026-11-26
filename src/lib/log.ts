/**
 * Structured JSON logging (one line per event). Log ids, not personal data:
 * pass user ids and ticket numbers, never email addresses, passwords or tokens.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const
type Level = keyof typeof LEVELS

function threshold(): number {
  const l = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level
  return LEVELS[l] ?? LEVELS.info
}

function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    const out: Record<string, unknown> = { name: value.name, message: value.message }
    const code = (value as { code?: unknown }).code
    if (code !== undefined) out.code = code
    if (threshold() <= LEVELS.debug && value.stack) out.stack = value.stack
    return out
  }
  return value
}

function emit(level: Level, event: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < threshold()) return
  const record: Record<string, unknown> = { ts: new Date().toISOString(), level, event }
  if (fields) for (const [k, v] of Object.entries(fields)) record[k] = serialize(v)
  const line = JSON.stringify(record)
  if (LEVELS[level] >= LEVELS.warn) console.error(line)
  else console.log(line)
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
}
