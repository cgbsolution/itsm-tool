/**
 * Email template overrides per tenant (email_templates). The defaults live in
 * code (DEFAULT_TEMPLATES); "reset to default" deletes the override.
 * Requires admin.itsm.
 */
import { q, q1, exec, tx } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { AppError, notFound } from "@/lib/errors"
import { audit } from "@/lib/audit"
import { DEFAULT_TEMPLATES, type TemplateDef } from "@/lib/email/templates"
import { assertPermission, auditActor } from "@/lib/admin/guard"
import { placeholdersIn } from "@/lib/admin/rules"

export type TemplateListRow = { key: string; description: string; overridden: boolean; is_active: boolean; updated_at: Date | null }

export async function listTemplatesAdmin(actor: Actor): Promise<TemplateListRow[]> {
  assertPermission(actor, "admin.itsm")
  const rows = await q<{ key: string; is_active: boolean; updated_at: Date }>("select key, is_active, updated_at from email_templates where tenant_id = $1", [actor.tenantId])
  return Object.entries(DEFAULT_TEMPLATES).map(([key, def]) => {
    const o = rows.find((r) => r.key === key)
    return { key, description: def.description, overridden: !!o, is_active: o?.is_active ?? false, updated_at: o?.updated_at ?? null }
  })
}

export type TemplateDetail = {
  key: string
  def: TemplateDef
  override: { subject: string; body: string; is_active: boolean; updated_at: Date } | null
  placeholders: string[]
}

/** Placeholders a template can use: those in its default text plus the recipient and brand. */
export function templatePlaceholders(key: string): string[] {
  const def = DEFAULT_TEMPLATES[key]
  if (!def) return []
  return [...new Set(["recipient.name", "brand.name", ...placeholdersIn(def.subject), ...placeholdersIn(def.body)])]
}

export async function getTemplateAdmin(actor: Actor, key: string): Promise<TemplateDetail> {
  assertPermission(actor, "admin.itsm")
  const def = DEFAULT_TEMPLATES[key]
  if (!def) throw notFound("Unknown template")
  const override = await q1<{ subject: string; body: string; is_active: boolean; updated_at: Date }>(
    "select subject, body, is_active, updated_at from email_templates where tenant_id = $1 and key = $2",
    [actor.tenantId, key]
  )
  return { key, def, override, placeholders: templatePlaceholders(key) }
}

export async function saveTemplate(actor: Actor, key: string, input: { subject: unknown; body: unknown }): Promise<void> {
  assertPermission(actor, "admin.itsm")
  if (!DEFAULT_TEMPLATES[key]) throw notFound("Unknown template")
  const subject = String(input.subject ?? "").replace(/[\r\n]+/g, " ").trim()
  const body = String(input.body ?? "").replace(/\r\n/g, "\n").trim()
  if (!subject) throw new AppError("Subject is required")
  if (subject.length > 250) throw new AppError("Subject: use at most 250 characters")
  if (!body) throw new AppError("Body is required")
  if (body.length > 20_000) throw new AppError("Body: use at most 20,000 characters")
  // placeholders outside the documented list are allowed (callers may pass more); the editor warns about them
  await tx(async (db) => {
    await exec(
      `insert into email_templates (tenant_id, key, subject, body, is_active, updated_at) values ($1, $2, $3, $4, true, now())
       on conflict (tenant_id, key) do update set subject = excluded.subject, body = excluded.body, is_active = true, updated_at = now()`,
      [actor.tenantId, key, subject, body],
      db
    )
    await audit(
      { tenantId: actor.tenantId, actor: auditActor(actor), action: "admin.email_template_saved", entityType: "email_template", entityId: key, summary: `Email template ${key} customised`, data: { key, subject } },
      db
    )
  })
}

export async function resetTemplate(actor: Actor, key: string): Promise<boolean> {
  assertPermission(actor, "admin.itsm")
  if (!DEFAULT_TEMPLATES[key]) throw notFound("Unknown template")
  return tx(async (db) => {
    const n = await exec("delete from email_templates where tenant_id = $1 and key = $2", [actor.tenantId, key], db)
    if (n) {
      await audit(
        { tenantId: actor.tenantId, actor: auditActor(actor), action: "admin.email_template_reset", entityType: "email_template", entityId: key, summary: `Email template ${key} reset to the default`, data: { key } },
        db
      )
    }
    return n > 0
  })
}

/** Sample values for the preview. */
export function sampleVars(appUrl: string, brandName: string, actorName: string): Record<string, unknown> {
  return {
    recipient: { name: "Alex Example" },
    brand: { name: brandName },
    actor: { name: actorName },
    ticket: {
      number: "INC0001234",
      subject: "Laptop does not connect to the VPN",
      type: "incident",
      priority: "P2 · High",
      status: "In progress",
      requester: "Alex Example",
      assignee: actorName,
      resolution: "Reinstalled the VPN client and renewed the certificate.",
      url: `${appUrl}/tickets/INC0001234`,
    },
    note: "Note: please keep the laptop switched on.",
    message: "Your ticket is now being worked on.",
    comment: "Could you tell us which network you were on when it failed?",
    reopen_days: 7,
    sla: { kind: "resolution", due: "27 Nov 2026, 14:30" },
    approvals: { url: `${appUrl}/approvals` },
    details: "Change window: Saturday 22:00 to 23:00",
    decision: "approved",
    link: `${appUrl}/reset/sample-token`,
    hours: 72,
  }
}
