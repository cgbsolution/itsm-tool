/**
 * System status for administrators: versions, migrations, job queue, email
 * outbox and storage use. Jobs have no tenant column, so a tenant
 * administrator sees (and retries) only dead jobs that belong to their
 * tenant; a super administrator sees all of them.
 */
import { q, q1, tx } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { audit } from "@/lib/audit"
import { queueStats } from "@/lib/jobs/worker"
import { pendingMigrations } from "@/lib/db/migrate"
import { config } from "@/lib/config"
import { AppError } from "@/lib/errors"
import { need, auditActor, requestIp } from "@/lib/sysadmin/guard"
import pkg from "../../../package.json"

export type DeadJob = {
  id: number
  kind: string
  payload: Record<string, unknown>
  attempts: number
  max_attempts: number
  last_error: string | null
  created_at: Date
  finished_at: Date | null
}

/** SQL condition: the job belongs to tenant $2 (or $1 = true: any job). */
const JOB_SCOPE = `($1::boolean
  or j.payload->>'tenantId' = $2::text
  or (j.kind = 'email.send' and exists (select 1 from email_outbox o where o.id::text = j.payload->>'outboxId' and o.tenant_id::text = $2::text)))`

export async function systemInfo(actor: Actor) {
  need(actor, "admin.settings")
  const [db, migrations, pending, jobs, outbox, files] = await Promise.all([
    q1<{ version: string }>("select version() as version"),
    q<{ version: string; applied_at: Date }>("select version, applied_at from schema_migrations order by version").catch(() => []),
    pendingMigrations().catch(() => [] as string[]),
    queueStats(),
    q<{ status: string; n: number }>("select status, count(*) as n from email_outbox where tenant_id = $1 group by status order by status", [actor.tenantId]),
    q1<{ n: number; bytes: number }>("select count(*) as n, coalesce(sum(size_bytes), 0) as bytes from files where tenant_id = $1", [actor.tenantId]),
  ])
  return {
    appVersion: (pkg as { version?: string }).version ?? "unknown",
    nodeVersion: process.version,
    dbVersion: db?.version ?? "unknown",
    migrations,
    pending,
    jobs,
    outbox,
    storageDir: config.storageDir(),
    files: { count: files?.n ?? 0, bytes: files?.bytes ?? 0 },
  }
}

export async function deadJobs(actor: Actor): Promise<DeadJob[]> {
  need(actor, "admin.settings")
  return q<DeadJob>(
    `select j.id, j.kind, j.payload, j.attempts, j.max_attempts, j.last_error, j.created_at, j.finished_at
       from jobs j
      where j.status = 'dead' and ${JOB_SCOPE}
      order by j.id desc
      limit 50`,
    [actor.isSuperadmin, actor.tenantId]
  )
}

export async function retryDeadJob(actor: Actor, jobId: number): Promise<void> {
  need(actor, "admin.settings")
  if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new AppError("Job not found", 404)
  const ip = await requestIp()
  await tx(async (db) => {
    const row = await q1<{ id: number; kind: string }>(
      `update jobs j set status = 'queued', attempts = 0, run_at = now(), locked_by = null, locked_at = null, finished_at = null
        where j.id = $3 and j.status = 'dead' and ${JOB_SCOPE}
        returning j.id, j.kind`,
      [actor.isSuperadmin, actor.tenantId, jobId],
      db
    )
    if (!row) throw new AppError("That job is not in the dead-letter queue", 409)
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "admin.job_retried",
        entityType: "job",
        entityId: String(row.id),
        summary: `Retried dead job #${row.id} (${row.kind})`,
        ip,
      },
      db
    )
  })
}
