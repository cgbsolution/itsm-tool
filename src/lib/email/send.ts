/**
 * Outgoing email: rendered into email_outbox inside the caller's transaction,
 * then delivered by the worker (job "email.send") with retries.
 */
import nodemailer, { type Transporter } from "nodemailer"
import { q1, exec, type Db, pool } from "@/lib/db"
import { config } from "@/lib/config"
import { maybeDecrypt } from "@/lib/crypto"
import { enqueue } from "@/lib/jobs/queue"
import { DEFAULT_TEMPLATES, layoutHtml, renderText, textToHtml } from "@/lib/email/templates"
import { log } from "@/lib/log"

export type QueueEmail = {
  tenantId: string | null
  to: string
  template: string
  vars: Record<string, unknown>
  relatedType?: string
  relatedId?: string
  headers?: Record<string, string>
}

export async function tenantBrand(tenantId: string | null, db: Db = pool()) {
  if (!tenantId) return { name: config.productName(), color: "#2563eb" }
  const row = await q1<{ name: string; brand_name: string | null; brand_color: string | null }>(
    `select t.name, s.brand_name, s.brand_color from tenants t left join tenant_settings s on s.tenant_id = t.id where t.id = $1`,
    [tenantId],
    db
  )
  return { name: row?.brand_name || row?.name || config.productName(), color: row?.brand_color || "#2563eb" }
}

async function template(tenantId: string | null, key: string, db: Db) {
  if (tenantId) {
    const custom = await q1<{ subject: string; body: string }>(
      "select subject, body from email_templates where tenant_id = $1 and key = $2 and is_active",
      [tenantId, key],
      db
    )
    if (custom) return custom
  }
  const def = DEFAULT_TEMPLATES[key]
  if (!def) throw new Error(`Unknown email template ${key}`)
  return def
}

export async function queueEmail(msg: QueueEmail, db: Db = pool()): Promise<void> {
  if (!msg.to || !/^[^@\s]+@[^@\s]+$/.test(msg.to)) return
  const brand = await tenantBrand(msg.tenantId, db)
  const tpl = await template(msg.tenantId, msg.template, db)
  const vars = { ...msg.vars, brand: { name: brand.name } }
  const subject = renderText(tpl.subject, vars).replace(/[\r\n]+/g, " ").slice(0, 250)
  const text = renderText(tpl.body, vars)
  const html = layoutHtml(textToHtml(text), brand)
  const row = await q1<{ id: string }>(
    `insert into email_outbox (tenant_id, to_address, subject, body_text, body_html, headers, related_type, related_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [msg.tenantId, msg.to, subject, text, html, JSON.stringify(msg.headers ?? {}), msg.relatedType ?? null, msg.relatedId ?? null],
    db
  )
  await enqueue("email.send", { outboxId: row!.id }, { maxAttempts: 6 }, db)
}

type SmtpSettings = { host?: string; port: number; secure: boolean; user?: string; password?: string; from?: string }

async function smtpFor(tenantId: string | null): Promise<SmtpSettings> {
  if (tenantId) {
    const s = await q1<{
      smtp_host: string | null
      smtp_port: number | null
      smtp_secure: boolean
      smtp_user: string | null
      smtp_password_enc: string | null
      from_address: string | null
    }>("select smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password_enc, from_address from tenant_mail_settings where tenant_id = $1", [tenantId])
    if (s?.smtp_host) {
      return {
        host: s.smtp_host,
        port: s.smtp_port ?? 587,
        secure: s.smtp_secure,
        user: s.smtp_user ?? undefined,
        password: maybeDecrypt(s.smtp_password_enc),
        from: s.from_address ?? undefined,
      }
    }
  }
  return config.smtp()
}

/** Whether outgoing email can be delivered for a tenant (its own SMTP or the default). */
export async function smtpConfigured(tenantId: string | null): Promise<boolean> {
  return !!(await smtpFor(tenantId)).host
}

const transports = new Map<string, Transporter>()

function transportFor(s: SmtpSettings): Transporter {
  const key = `${s.host}:${s.port}:${s.secure}:${s.user ?? ""}:${s.password?.length ?? 0}`
  let t = transports.get(key)
  if (!t) {
    t = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure,
      auth: s.user ? { user: s.user, pass: s.password ?? "" } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    })
    transports.set(key, t)
  }
  return t
}

/** Job handler: delivers one outbox row. Throws to retry. */
export async function deliverOutbox(outboxId: string): Promise<void> {
  const m = await q1<{
    id: string
    tenant_id: string | null
    to_address: string
    subject: string
    body_text: string
    body_html: string
    headers: Record<string, string>
    status: string
  }>("select id, tenant_id, to_address, subject, body_text, body_html, headers, status from email_outbox where id = $1", [outboxId])
  if (!m || m.status === "sent" || m.status === "skipped") return
  const smtp = await smtpFor(m.tenant_id)
  if (!smtp.host) {
    await exec("update email_outbox set status = 'skipped', last_error = 'No SMTP server is configured' where id = $1", [m.id])
    return
  }
  const brand = await tenantBrand(m.tenant_id)
  const fromAddress = smtp.from || smtp.user || `no-reply@${new URL(config.appUrl()).hostname}`
  try {
    await transportFor(smtp).sendMail({
      from: { name: brand.name, address: fromAddress },
      to: m.to_address,
      subject: m.subject,
      text: m.body_text,
      html: m.body_html,
      headers: { "Auto-Submitted": "auto-generated", ...m.headers },
    })
    await exec("update email_outbox set status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = null where id = $1", [m.id])
  } catch (err) {
    const message = (err as Error).message?.slice(0, 500) ?? "send failed"
    await exec("update email_outbox set status = 'failed', attempts = attempts + 1, last_error = $2 where id = $1", [m.id, message])
    log.warn("email.send_failed", { outbox_id: m.id, err })
    throw err
  }
}

/** Sends a test message synchronously (Admin > Email). */
export async function sendTestEmail(tenantId: string, to: string): Promise<void> {
  const smtp = await smtpFor(tenantId)
  if (!smtp.host) throw new Error("No SMTP server is configured")
  const brand = await tenantBrand(tenantId)
  await transportFor(smtp).sendMail({
    from: { name: brand.name, address: smtp.from || smtp.user || "no-reply@localhost" },
    to,
    subject: `${brand.name}: test email`,
    text: "This is a test message. Outgoing email works.",
  })
}
