/**
 * In-app notifications plus optional email, for any record (not only tickets).
 * Nobody is notified about their own action unless `includeActor` is set.
 */
import { q, type Db, pool } from "@/lib/db"
import { queueEmail } from "@/lib/email/send"

export type NotifyInput = {
  tenantId: string
  recipients: (string | null | undefined)[]
  actorId: string | null
  kind: string
  title: string
  body?: string | null
  link?: string | null
  entityType?: string
  entityId?: string
  includeActor?: boolean
  web?: boolean
  email?: { template: string; vars: Record<string, unknown>; headers?: Record<string, string> }
}

export async function notify(input: NotifyInput, db: Db = pool()): Promise<void> {
  const ids = [...new Set(input.recipients.filter((v): v is string => !!v))].filter(
    (id) => input.includeActor || id !== input.actorId
  )
  if (ids.length === 0) return

  const people = await q<{ id: string; email: string; full_name: string; status: string }>(
    "select id, email, full_name, status from users where id = any($1::uuid[]) and tenant_id = $2",
    [ids, input.tenantId],
    db
  )
  const active = people.filter((p) => p.status === "active")
  if (active.length === 0) return

  if (input.web !== false) {
    const values: string[] = []
    const params: unknown[] = []
    for (const p of active) {
      if (p.id === input.actorId) continue // the actor never gets a web notification
      const base = params.length
      params.push(input.tenantId, p.id, input.actorId, input.kind, input.title.slice(0, 300), input.body ?? null, input.link ?? null, input.entityType ?? null, input.entityId ?? null)
      values.push(`(${Array.from({ length: 9 }, (_, i) => `$${base + i + 1}`).join(", ")})`)
    }
    if (values.length) {
      await q(
        `insert into notifications (tenant_id, user_id, actor_id, kind, title, body, link, entity_type, entity_id) values ${values.join(", ")}`,
        params,
        db
      )
    }
  }

  if (input.email) {
    for (const p of active) {
      if (!p.email) continue
      await queueEmail(
        {
          tenantId: input.tenantId,
          to: p.email,
          template: input.email.template,
          vars: { ...input.email.vars, recipient: { name: p.full_name || p.email } },
          relatedType: input.entityType,
          relatedId: input.entityId,
          headers: input.email.headers,
        },
        db
      )
    }
  }
}

/** Users of a tenant who work tickets (system staff roles or custom roles with ticket.work). */
export async function staffUserIds(tenantId: string, db: Db = pool()): Promise<string[]> {
  const rows = await q<{ id: string }>(
    `select u.id from users u
       left join custom_roles r on r.tenant_id = u.tenant_id and r.key = u.role
      where u.tenant_id = $1 and u.status = 'active'
        and (u.role in ('engineer', 'admin', 'superadmin') or 'ticket.work' = any(coalesce(r.permissions, '{}')))`,
    [tenantId],
    db
  )
  return rows.map((r) => r.id)
}

export async function adminUserIds(tenantId: string, db: Db = pool()): Promise<string[]> {
  const rows = await q<{ id: string }>(
    "select id from users where tenant_id = $1 and status = 'active' and role = 'admin'",
    [tenantId],
    db
  )
  return rows.map((r) => r.id)
}

export async function groupMemberIds(groupId: string | null | undefined, db: Db = pool()): Promise<string[]> {
  if (!groupId) return []
  const rows = await q<{ user_id: string }>("select user_id from group_members where group_id = $1", [groupId], db)
  return rows.map((r) => r.user_id)
}
