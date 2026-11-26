/**
 * Postgres-backed job queue. Enqueue inside the caller's transaction so a job
 * exists only if the change that caused it was committed (transactional outbox).
 */
import { q1, type Db, pool } from "@/lib/db"

export type EnqueueOptions = {
  runAt?: Date
  maxAttempts?: number
  /** Only one job per key ever exists (idempotency / one scheduled run per slot) */
  dedupeKey?: string
}

export async function enqueue(kind: string, payload: Record<string, unknown> = {}, opts: EnqueueOptions = {}, db: Db = pool()): Promise<number | null> {
  const row = await q1<{ id: number }>(
    `insert into jobs (kind, payload, run_at, max_attempts, dedupe_key)
     values ($1, $2, coalesce($3, now()), $4, $5)
     on conflict (dedupe_key) do nothing
     returning id`,
    [kind, JSON.stringify(payload), opts.runAt ?? null, opts.maxAttempts ?? 5, opts.dedupeKey ?? null],
    db
  )
  return row?.id ?? null
}
