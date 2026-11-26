/**
 * PostgreSQL access. Server-side only: the browser never talks to the database.
 * Every query that touches tenant data must filter on tenant_id explicitly.
 */
import pg from "pg"
import { config } from "@/lib/config"
import { log } from "@/lib/log"

const { Pool, types } = pg
export type PoolClient = pg.PoolClient
export type Db = pg.Pool | pg.PoolClient

// numeric -> number, int8 (count(*), bigserial) -> number, date -> 'YYYY-MM-DD' string
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)))
types.setTypeParser(20, (v) => (v === null ? null : Number(v)))
types.setTypeParser(1082, (v) => v)

const g = globalThis as unknown as { __itsmPool?: pg.Pool }

export function pool(): pg.Pool {
  if (!g.__itsmPool) {
    const p = new Pool({
      connectionString: config.databaseUrl(),
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
    p.on("error", (err) => log.error("db.pool_error", { err }))
    g.__itsmPool = p
  }
  return g.__itsmPool
}

/** Rows of a query. */
export async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = [], db: Db = pool()): Promise<T[]> {
  const res = await db.query(sql, params as unknown[])
  return res.rows as T[]
}

/** First row, or null. */
export async function q1<T = Record<string, unknown>>(sql: string, params: unknown[] = [], db: Db = pool()): Promise<T | null> {
  const res = await db.query(sql, params as unknown[])
  return (res.rows[0] as T) ?? null
}

/** Number of affected rows. */
export async function exec(sql: string, params: unknown[] = [], db: Db = pool()): Promise<number> {
  const res = await db.query(sql, params as unknown[])
  return res.rowCount ?? 0
}

/** Runs `fn` in a transaction; rolls back on any error. */
export async function tx<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect()
  try {
    await client.query("begin")
    const result = await fn(client)
    await client.query("commit")
    return result
  } catch (err) {
    await client.query("rollback").catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Builds positional parameters for dynamic SQL: `where.push(\`x = ${p.add(v)}\`)`. */
export class Params {
  values: unknown[] = []
  add(value: unknown): string {
    this.values.push(value)
    return `$${this.values.length}`
  }
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string }
  return e?.code === "23505" && (!constraint || e.constraint === constraint)
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v)
}
