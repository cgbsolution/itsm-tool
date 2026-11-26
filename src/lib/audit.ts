/**
 * Writes to the append-only, hash-chained audit log (see 0001_platform.sql).
 * Use for security-relevant events: sign-in, role/permission changes, settings,
 * deletes, scripts run on endpoints, patch approvals, imports, licence.
 */
import { q, type Db, pool } from "@/lib/db"
import { log } from "@/lib/log"

export type AuditActor = { id: string; email?: string | null } | null

export type AuditEntry = {
  tenantId: string | null
  actor: AuditActor
  action: string
  entityType?: string
  entityId?: string | null
  summary?: string
  data?: Record<string, unknown>
  ip?: string | null
}

export async function audit(entry: AuditEntry, db: Db = pool()): Promise<void> {
  await q(
    `insert into audit_log (tenant_id, actor_id, actor_label, action, entity_type, entity_id, summary, data, ip)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.tenantId,
      entry.actor?.id ?? null,
      entry.actor?.email ?? (entry.actor ? null : "system"),
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.summary ?? null,
      entry.data ? JSON.stringify(entry.data) : null,
      entry.ip ?? null,
    ],
    db
  )
}

/** Audit without failing the caller (for best-effort events such as failed sign-ins). */
export async function auditSafe(entry: AuditEntry): Promise<void> {
  try {
    await audit(entry)
  } catch (err) {
    log.error("audit.write_failed", { action: entry.action, err })
  }
}

/**
 * Recomputes the chain. Returns the first broken id, or null when intact.
 * The hash input is computed by the same SQL function the trigger uses.
 */
export async function verifyAuditChain(db: Db = pool()): Promise<{ checked: number; brokenAt: number | null }> {
  const rows = await q<{ id: number; ok: boolean; linked: boolean }>(
    `select id,
            hash = encode(sha256(convert_to(audit_log_hash_input(a), 'UTF8')), 'hex') as ok,
            prev_hash = coalesce(lag(hash) over (order by id), '') as linked
       from audit_log a
      order by id`,
    [],
    db
  )
  for (const r of rows) if (!r.ok || !r.linked) return { checked: rows.length, brokenAt: r.id }
  return { checked: rows.length, brokenAt: null }
}
