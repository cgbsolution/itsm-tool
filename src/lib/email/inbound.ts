/**
 * Email-to-ticket. Polls each tenant's IMAP mailbox (Admin › Email):
 * - a reply whose subject carries a ticket number ([INC0001234]) from someone
 *   linked to that ticket becomes a public comment;
 * - anything else becomes a new incident (source "email");
 * - auto-replies, bounces and our own messages are ignored (no mail loops);
 * - attachments go through the same checks as uploads.
 * Sender addresses can be forged; rely on SPF/DKIM/DMARC at the mail server,
 * and note that email replies can only add public comments.
 */
import { ImapFlow } from "imapflow"
import { simpleParser, type ParsedMail } from "mailparser"
import { q, q1, exec, tx } from "@/lib/db"
import { maybeDecrypt } from "@/lib/crypto"
import { actorForUser } from "@/lib/auth/session"
import { systemActor } from "@/lib/auth/system"
import { addComment, createTicket } from "@/lib/itsm/tickets"
import { saveBuffer } from "@/lib/files/storage"
import { loadTenantSettings } from "@/lib/itsm/config"
import { config } from "@/lib/config"
import { log } from "@/lib/log"

const NUMBER_RE = /\b((?:INC|REQ|PRB|CHG)\d{7})\b/i
const MAX_PER_POLL = 25

type MailSettings = {
  tenant_id: string
  imap_host: string
  imap_port: number | null
  imap_secure: boolean
  imap_user: string
  imap_password_enc: string | null
  imap_folder: string
  from_address: string | null
  smtp_user: string | null
}

export function isAutomatic(mail: ParsedMail): boolean {
  const h = mail.headers
  const auto = String(h.get("auto-submitted") ?? "").toLowerCase()
  if (auto && auto !== "no") return true
  const precedence = String(h.get("precedence") ?? "").toLowerCase()
  if (["bulk", "junk", "list", "auto_reply"].includes(precedence)) return true
  if (h.has("x-autoreply") || h.has("x-autorespond") || h.has("x-auto-response-suppress") && String(h.get("x-auto-response-suppress")).includes("All")) return true
  const from = mail.from?.value[0]?.address?.toLowerCase() ?? ""
  return /^(mailer-daemon|postmaster|no-?reply|noreply)@/.test(from)
}

/** The new part of a reply: drops quoted history and common reply headers. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const out: string[] = []
  for (const line of lines) {
    if (/^On .{4,200}wrote:\s*$/.test(line.trim())) break
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break
    if (/^From:\s.+/i.test(line.trim()) && out.length > 0) break
    if (/^_{10,}$/.test(line.trim())) break
    if (line.startsWith(">")) continue
    out.push(line)
  }
  return out.join("\n").trim()
}

function bodyText(mail: ParsedMail): string {
  if (mail.text) return mail.text
  if (typeof mail.html === "string") return mail.html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ")
  return ""
}

export async function handleInbound(tenantId: string, mail: ParsedMail, ownAddresses: string[]): Promise<"comment" | "ticket" | "ignored"> {
  const from = mail.from?.value[0]
  const email = from?.address?.trim().toLowerCase()
  if (!email || isAutomatic(mail) || ownAddresses.includes(email)) return "ignored"
  const subject = (mail.subject ?? "(no subject)").replace(/[\r\n]+/g, " ").trim().slice(0, 300) || "(no subject)"
  const text = stripQuoted(bodyText(mail)).slice(0, 20_000)
  const settings = await loadTenantSettings(tenantId)

  return tx(async (db) => {
    let user = await q1<{ id: string; status: string }>("select id, status from users where tenant_id = $1 and lower(email) = $2", [tenantId, email], db)
    if (!user && settings.inbound_create_users) {
      user = await q1<{ id: string; status: string }>(
        "insert into users (tenant_id, email, full_name, role, status) values ($1, $2, $3, 'user', 'active') on conflict do nothing returning id, status",
        [tenantId, email, (from?.name || email).slice(0, 200)],
        db
      )
    }
    const actor = user && user.status === "active" ? await actorForUser(user.id, "email") : null
    const saveFiles = async (ticketId: string) => {
      for (const a of mail.attachments ?? []) {
        if (a.contentDisposition === "inline" && a.size < 5_000) continue // signature logos
        try {
          await saveBuffer(a.content, a.filename ?? "attachment", { tenantId, entityType: "ticket", entityId: ticketId, uploadedBy: user?.id ?? null }, db)
        } catch (err) {
          log.info("email.attachment_refused", { ticket: ticketId, reason: (err as Error).message })
        }
      }
    }

    const m = NUMBER_RE.exec(subject)
    if (m) {
      const t = await q1<{ id: string; requester_id: string | null; assignee_id: string | null }>(
        "select id, requester_id, assignee_id from tickets where tenant_id = $1 and upper(number) = upper($2)",
        [tenantId, m[1]],
        db
      )
      if (t && actor) {
        const linked =
          t.requester_id === actor.id ||
          t.assignee_id === actor.id ||
          actor.permissions.has("ticket.view_all") ||
          !!(await q1("select 1 from ticket_watchers where ticket_id = $1 and user_id = $2", [t.id, actor.id], db))
        if (linked) {
          try {
            await addComment(actor, t.id, { body: text || "(empty reply)", source: "email" }, db)
            await saveFiles(t.id)
            return "comment" as const
          } catch (err) {
            log.info("email.reply_not_added", { ticket: m[1], reason: (err as Error).message })
          }
        }
      }
    }

    const creator = actor ?? systemActor(tenantId)
    const ticket = await createTicket(
      creator,
      {
        type: "incident",
        subject,
        description: text || "(no text)",
        source: "email",
        requesterName: actor ? undefined : `${from?.name ? from.name + " " : ""}<${email}>`.slice(0, 200),
        contact: actor ? undefined : email,
      },
      db
    )
    await saveFiles(ticket.id)
    return "ticket" as const
  })
}

export async function pollTenantMailbox(s: MailSettings): Promise<{ processed: number }> {
  const client = new ImapFlow({
    host: s.imap_host,
    port: s.imap_port ?? 993,
    secure: s.imap_secure,
    auth: { user: s.imap_user, pass: maybeDecrypt(s.imap_password_enc) ?? "" },
    logger: false,
    socketTimeout: 60_000,
  })
  const own = [s.from_address, s.smtp_user, s.imap_user, process.env.SMTP_FROM].filter((v): v is string => !!v).map((v) => v.toLowerCase())
  let processed = 0
  await client.connect()
  try {
    const lock = await client.getMailboxLock(s.imap_folder || "INBOX")
    try {
      const batch: { uid: number; source: Buffer }[] = []
      for await (const msg of client.fetch({ seen: false }, { uid: true, source: true })) {
        if (msg.source) batch.push({ uid: msg.uid, source: msg.source })
        if (batch.length >= MAX_PER_POLL) break
      }
      for (const m of batch) {
        try {
          const parsed = await simpleParser(m.source)
          const result = await handleInbound(s.tenant_id, parsed, own)
          log.info("email.inbound", { tenant: s.tenant_id, result })
        } catch (err) {
          log.error("email.inbound_failed", { tenant: s.tenant_id, uid: m.uid, err })
        }
        // mark seen either way so a bad message cannot block the mailbox
        await client.messageFlagsAdd({ uid: String(m.uid) }, ["\\Seen"], { uid: true })
        processed++
      }
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => {})
  }
  return { processed }
}

export async function runMailPoll(): Promise<void> {
  const tenants = await q<MailSettings>(
    `select m.tenant_id, m.imap_host, m.imap_port, m.imap_secure, m.imap_user, m.imap_password_enc, m.imap_folder, m.from_address, m.smtp_user
       from tenant_mail_settings m join tenants t on t.id = m.tenant_id
      where m.imap_enabled and t.status = 'active' and m.imap_host is not null and m.imap_user is not null`
  )
  for (const s of tenants) {
    try {
      await pollTenantMailbox(s)
      await exec("update tenant_mail_settings set imap_last_poll_at = now(), imap_last_error = null where tenant_id = $1", [s.tenant_id])
    } catch (err) {
      await exec("update tenant_mail_settings set imap_last_poll_at = now(), imap_last_error = $2 where tenant_id = $1", [s.tenant_id, (err as Error).message?.slice(0, 500) ?? "error"])
      log.warn("email.poll_failed", { tenant: s.tenant_id, err })
    }
  }
}

/** Connection check for the admin screen. */
export async function testImap(s: Pick<MailSettings, "imap_host" | "imap_port" | "imap_secure" | "imap_user" | "imap_password_enc" | "imap_folder">): Promise<string> {
  const client = new ImapFlow({ host: s.imap_host, port: s.imap_port ?? 993, secure: s.imap_secure, auth: { user: s.imap_user, pass: maybeDecrypt(s.imap_password_enc) ?? "" }, logger: false, socketTimeout: 20_000 })
  await client.connect()
  try {
    const status = await client.status(s.imap_folder || "INBOX", { messages: true, unseen: true })
    if (!status) return `Connected, but the folder ${s.imap_folder || "INBOX"} was not found.`
    return `Connected. ${status.messages ?? 0} messages, ${status.unseen ?? 0} unread in ${s.imap_folder || "INBOX"}.`
  } finally {
    await client.logout().catch(() => {})
  }
}

export const inboundAddressHint = () => `Replies keep the ticket number in the subject, e.g. "[INC0001001] …". Mail from ${config.appUrl()} users is matched by email address.`
