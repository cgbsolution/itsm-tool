/**
 * Schema migrations: plain SQL files `db/migrations/NNNN_name.sql`, applied in
 * order, each in its own transaction, recorded in `schema_migrations` with a
 * checksum. A cluster-wide advisory lock makes concurrent starts safe.
 */
import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { pool } from "@/lib/db"
import { config } from "@/lib/config"
import { log } from "@/lib/log"

const LOCK_KEY = 7311000

function checksum(sql: string) {
  return crypto.createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex")
}

async function migrationFiles(dir: string) {
  const names = (await fs.readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(f)).sort()
  return Promise.all(
    names.map(async (name) => {
      const sql = await fs.readFile(path.join(dir, name), "utf8")
      return { version: name.replace(/\.sql$/i, ""), sql, checksum: checksum(sql) }
    })
  )
}

export async function migrate(dir = config.migrationsDir()): Promise<{ applied: string[]; total: number }> {
  const files = await migrationFiles(dir)
  const client = await pool().connect()
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY])
    await client.query(
      `create table if not exists schema_migrations (
         version text primary key,
         checksum text not null,
         applied_at timestamptz not null default now()
       )`
    )
    const rows = (await client.query("select version, checksum from schema_migrations")).rows as {
      version: string
      checksum: string
    }[]
    const done = new Map(rows.map((r) => [r.version, r.checksum]))
    const applied: string[] = []
    for (const f of files) {
      const previous = done.get(f.version)
      if (previous) {
        if (previous !== f.checksum) log.warn("db.migration_changed_after_apply", { version: f.version })
        continue
      }
      await client.query("begin")
      try {
        await client.query(f.sql)
        await client.query("insert into schema_migrations (version, checksum) values ($1, $2)", [f.version, f.checksum])
        await client.query("commit")
      } catch (err) {
        await client.query("rollback").catch(() => {})
        throw new Error(`Migration ${f.version} failed: ${(err as Error).message}`)
      }
      applied.push(f.version)
      log.info("db.migration_applied", { version: f.version })
    }
    return { applied, total: files.length }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {})
    client.release()
  }
}

/** Migrations on disk that the database has not applied (for the readiness check). */
export async function pendingMigrations(dir = config.migrationsDir()): Promise<string[]> {
  const files = await migrationFiles(dir)
  let applied = new Set<string>()
  try {
    const res = await pool().query("select version from schema_migrations")
    applied = new Set((res.rows as { version: string }[]).map((r) => r.version))
  } catch {
    // table missing: everything is pending
  }
  return files.map((f) => f.version).filter((v) => !applied.has(v))
}
