/**
 * Outgoing (SMTP) and incoming (IMAP, email-to-ticket) mail settings, the
 * test message, and the outbox viewer. Passwords are stored encrypted and
 * never leave the server: reads only say whether one is set.
 */
import { q, q1, tx, exec, isUuid } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { audit } from "@/lib/audit"
import { encryptSecret } from "@/lib/crypto"
import { sendTestEmail } from "@/lib/email/send"
import { enqueue } from "@/lib/jobs/queue"
import { AppError, notFound } from "@/lib/errors"
import { config } from "@/lib/config"
import { need, auditActor, requestIp } from "@/lib/sysadmin/guard"
import { emailAddress, mailSettingsFrom, secretAuditLabel, type SecretChange } from "@/lib/sysadmin/validate"

export type MailSettingsView = {
  smtp_host: string | null
  smtp_port: number | null
  smtp_secure: boolean
  smtp_user: string | null
  smtp_password_set: boolean
  from_address: string | null
  imap_enabled: boolean
  imap_host: string | null
  imap_port: number | null
  imap_secure: boolean
  imap_user: string | null
  imap_password_set: boolean
  imap_folder: string
  imap_last_poll_at: Date | null
  imap_last_error: string | null
  updated_at: Date | null
  /** SMTP from the server environment is used when no host is set here */
  envSmtpHost: string | null
}

export async function getMailSettings(actor: Actor): Promise<MailSettingsView> {
  need(actor, "admin.settings")
  const r = await q1<Omit<MailSettingsView, "envSmtpHost">>(
    `select smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password_enc is not null as smtp_password_set, from_address,
            imap_enabled, imap_host, imap_port, imap_secure, imap_user, imap_password_enc is not null as imap_password_set,
            imap_folder, imap_last_poll_at, imap_last_error, updated_at
       from tenant_mail_settings where tenant_id = $1`,
    [actor.tenantId]
  )
  const envSmtpHost = config.smtp().host ?? null
  return (
    (r && { ...r, envSmtpHost }) ?? {
      smtp_host: null,
      smtp_port: null,
      smtp_secure: false,
      smtp_user: null,
      smtp_password_set: false,
      from_address: null,
      imap_enabled: false,
      imap_host: null,
      imap_port: 993,
      imap_secure: true,
      imap_user: null,
      imap_password_set: false,
      imap_folder: "INBOX",
      imap_last_poll_at: null,
      imap_last_error: null,
      updated_at: null,
      envSmtpHost,
    }
  )
}

function applySecret(current: string | null, change: SecretChange): string | null {
  if (change.kind === "set") return encryptSecret(change.value)
  if (change.kind === "clear") return null
  return current
}

export async function updateMailSettings(actor: Actor, input: Record<string, unknown>): Promise<void> {
  need(actor, "admin.settings")
  const m = mailSettingsFrom(input)
  const ip = await requestIp()
  await tx(async (db) => {
    const cur = await q1<{ smtp_password_enc: string | null; imap_password_enc: string | null }>(
      "select smtp_password_enc, imap_password_enc from tenant_mail_settings where tenant_id = $1 for update",
      [actor.tenantId],
      db
    )
    const smtpPass = applySecret(cur?.smtp_password_enc ?? null, m.smtp_password)
    const imapPass = applySecret(cur?.imap_password_enc ?? null, m.imap_password)
    if (m.imap_enabled && !imapPass) throw new AppError("To turn on email-to-ticket, set the IMAP password")
    await exec(
      `insert into tenant_mail_settings (tenant_id, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password_enc, from_address,
                                         imap_enabled, imap_host, imap_port, imap_secure, imap_user, imap_password_enc, imap_folder, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
       on conflict (tenant_id) do update set
         smtp_host = excluded.smtp_host, smtp_port = excluded.smtp_port, smtp_secure = excluded.smtp_secure,
         smtp_user = excluded.smtp_user, smtp_password_enc = excluded.smtp_password_enc, from_address = excluded.from_address,
         imap_enabled = excluded.imap_enabled, imap_host = excluded.imap_host, imap_port = excluded.imap_port,
         imap_secure = excluded.imap_secure, imap_user = excluded.imap_user, imap_password_enc = excluded.imap_password_enc,
         imap_folder = excluded.imap_folder, updated_at = now()`,
      [
        actor.tenantId, m.smtp_host, m.smtp_port, m.smtp_secure, m.smtp_user, smtpPass, m.from_address,
        m.imap_enabled, m.imap_host, m.imap_port, m.imap_secure, m.imap_user, imapPass, m.imap_folder,
      ],
      db
    )
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "admin.mail_settings_updated",
        entityType: "tenant",
        entityId: actor.tenantId,
        summary: "Email settings saved",
        data: {
          smtp_host: m.smtp_host,
          smtp_port: m.smtp_port,
          smtp_secure: m.smtp_secure,
          smtp_user: m.smtp_user,
          smtp_password: secretAuditLabel(m.smtp_password),
          from_address: m.from_address,
          imap_enabled: m.imap_enabled,
          imap_host: m.imap_host,
          imap_port: m.imap_port,
          imap_secure: m.imap_secure,
          imap_user: m.imap_user,
          imap_password: secretAuditLabel(m.imap_password),
          imap_folder: m.imap_folder,
        },
        ip,
      },
      db
    )
  })
}

export async function sendTestMessage(actor: Actor, to: unknown): Promise<string> {
  need(actor, "admin.settings")
  const address = emailAddress(to, "Send to", true)!
  try {
    await sendTestEmail(actor.tenantId, address)
  } catch (err) {
    // SMTP errors carry server replies, never our stored credentials
    const msg = ((err as Error)?.message ?? "unknown error").replace(/\s+/g, " ").slice(0, 300)
    throw new AppError(`The test email could not be sent: ${msg}`)
  }
  await audit({
    tenantId: actor.tenantId,
    actor: auditActor(actor),
    action: "admin.mail_test_sent",
    entityType: "tenant",
    entityId: actor.tenantId,
    summary: `Test email sent to ${address}`,
    ip: await requestIp(),
  })
  return address
}

export const OUTBOX_STATUSES = ["queued", "sent", "failed", "skipped"] as const

export type OutboxRow = {
  id: string
  to_address: string
  subject: string
  status: string
  attempts: number
  last_error: string | null
  created_at: Date
  sent_at: Date | null
}

export async function listOutbox(actor: Actor, status?: string | null): Promise<OutboxRow[]> {
  need(actor, "admin.settings")
  const filter = status && (OUTBOX_STATUSES as readonly string[]).includes(status) ? status : null
  return q<OutboxRow>(
    `select id, to_address, subject, status, attempts, last_error, created_at, sent_at
       from email_outbox
      where tenant_id = $1 and ($2::text is null or status = $2)
      order by created_at desc
      limit 200`,
    [actor.tenantId, filter]
  )
}

export async function outboxCounts(actor: Actor): Promise<Record<string, number>> {
  need(actor, "admin.settings")
  const rows = await q<{ status: string; n: number }>("select status, count(*) as n from email_outbox where tenant_id = $1 group by status", [actor.tenantId])
  return Object.fromEntries(rows.map((r) => [r.status, r.n]))
}

/** Puts a failed message back in the queue. */
export async function retryOutbox(actor: Actor, outboxId: string): Promise<void> {
  need(actor, "admin.settings")
  if (!isUuid(outboxId)) throw notFound("Message not found")
  const ip = await requestIp()
  await tx(async (db) => {
    const row = await q1<{ id: string; to_address: string; subject: string }>(
      `update email_outbox set status = 'queued', last_error = null
        where id = $1 and tenant_id = $2 and status = 'failed'
        returning id, to_address, subject`,
      [outboxId, actor.tenantId],
      db
    )
    if (!row) throw new AppError("Only failed messages can be retried", 409)
    await enqueue("email.send", { outboxId: row.id }, { maxAttempts: 6 }, db)
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "admin.mail_retried",
        entityType: "email_outbox",
        entityId: row.id,
        summary: `Retried email "${row.subject.slice(0, 120)}"`,
        ip,
      },
      db
    )
  })
}
