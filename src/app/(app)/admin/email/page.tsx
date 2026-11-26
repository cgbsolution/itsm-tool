import Link from "next/link"
import { requirePermission } from "@/lib/auth/session"
import { getMailSettings, listOutbox, outboxCounts, OUTBOX_STATUSES } from "@/lib/sysadmin/mail"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, EmptyState, Field, KeyValues, PageHeader, When, type Tone } from "@/components/ui"
import { formatDateTime } from "@/lib/format"
import { saveMailAction, testMailAction, retryOutboxAction } from "./actions"

export const metadata = { title: "Email" }

const STATUS_TONE: Record<string, Tone> = { queued: "blue", sent: "green", failed: "red", skipped: "amber" }

function PasswordField({ name, label, isSet }: { name: string; label: string; isSet: boolean }) {
  return (
    <Field label={label} htmlFor={name} hint={isSet ? "A password is set. Leave empty to keep it." : "No password is set."}>
      <input id={name} name={name} type="password" autoComplete="new-password" className="input" maxLength={1000} placeholder={isSet ? "•••••••• (set)" : ""} />
      {isSet && (
        <label className="mt-1 flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" name={`${name}_clear`} /> Clear the stored password
        </label>
      )}
    </Field>
  )
}

export default async function EmailPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await requirePermission("admin.settings")
  const sp = await searchParams
  const status = sp.status && (OUTBOX_STATUSES as readonly string[]).includes(sp.status) ? sp.status : ""
  const [m, outbox, counts] = await Promise.all([getMailSettings(actor), listOutbox(actor, status || null), outboxCounts(actor)])
  const tz = actor.tenant.timezone

  return (
    <>
      <PageHeader title="Email" subtitle="Outgoing mail (SMTP), email-to-ticket (IMAP) and the outbox" back={{ href: "/admin", label: "Administration" }} />

      <div className="grid gap-4 xl:grid-cols-3">
        <ActionForm action={saveMailAction} className="space-y-4 xl:col-span-2">
          <Card title="Outgoing mail (SMTP)">
            <p className="mb-3 text-xs text-slate-500">
              {m.envSmtpHost
                ? "Leave the server empty to use the server-wide SMTP settings from the environment."
                : "Leave the server empty to send no email (messages are marked skipped)."}
            </p>
            <div className="grid gap-4 sm:grid-cols-6">
              <Field label="SMTP server" htmlFor="smtp_host" className="sm:col-span-3">
                <input id="smtp_host" name="smtp_host" className="input" maxLength={253} defaultValue={m.smtp_host ?? ""} placeholder="smtp.example.com" />
              </Field>
              <Field label="Port" htmlFor="smtp_port" className="sm:col-span-1">
                <input id="smtp_port" name="smtp_port" type="number" min={1} max={65535} className="input" defaultValue={m.smtp_port ?? ""} placeholder="587" />
              </Field>
              <div className="flex items-end pb-2 sm:col-span-2">
                <label className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" name="smtp_secure" defaultChecked={m.smtp_secure} /> TLS from the start (port 465)
                </label>
              </div>
              <Field label="User name" htmlFor="smtp_user" className="sm:col-span-3">
                <input id="smtp_user" name="smtp_user" className="input" maxLength={255} autoComplete="off" defaultValue={m.smtp_user ?? ""} />
              </Field>
              <div className="sm:col-span-3">
                <PasswordField name="smtp_password" label="Password" isSet={m.smtp_password_set} />
              </div>
              <Field label="From address" htmlFor="from_address" className="sm:col-span-6" hint="Messages are sent as “brand name <this address>”. Empty = the SMTP user name.">
                <input id="from_address" name="from_address" type="email" className="input" maxLength={254} defaultValue={m.from_address ?? ""} placeholder="servicedesk@example.com" />
              </Field>
            </div>
          </Card>

          <Card title="Email-to-ticket (IMAP)">
            <label className="mb-3 flex items-start gap-2 text-sm">
              <input type="checkbox" name="imap_enabled" defaultChecked={m.imap_enabled} className="mt-0.5" />
              <span>
                <span className="font-medium">Create and update tickets from a mailbox</span>
                <span className="block text-xs text-slate-500">New messages become tickets; replies that keep the ticket number in the subject become comments.</span>
              </span>
            </label>
            <div className="grid gap-4 sm:grid-cols-6">
              <Field label="IMAP server" htmlFor="imap_host" className="sm:col-span-3">
                <input id="imap_host" name="imap_host" className="input" maxLength={253} defaultValue={m.imap_host ?? ""} placeholder="imap.example.com" />
              </Field>
              <Field label="Port" htmlFor="imap_port" className="sm:col-span-1">
                <input id="imap_port" name="imap_port" type="number" min={1} max={65535} className="input" defaultValue={m.imap_port ?? 993} />
              </Field>
              <div className="flex items-end pb-2 sm:col-span-2">
                <label className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" name="imap_secure" defaultChecked={m.imap_secure} /> TLS (port 993)
                </label>
              </div>
              <Field label="User name" htmlFor="imap_user" className="sm:col-span-3">
                <input id="imap_user" name="imap_user" className="input" maxLength={255} autoComplete="off" defaultValue={m.imap_user ?? ""} />
              </Field>
              <div className="sm:col-span-3">
                <PasswordField name="imap_password" label="Password" isSet={m.imap_password_set} />
              </div>
              <Field label="Folder" htmlFor="imap_folder" className="sm:col-span-3">
                <input id="imap_folder" name="imap_folder" className="input" maxLength={200} defaultValue={m.imap_folder} />
              </Field>
            </div>
          </Card>
          <div>
            <SubmitButton pendingText="Saving…">Save email settings</SubmitButton>
          </div>
        </ActionForm>

        <div className="space-y-4">
          <Card title="Send a test email">
            <ActionForm action={testMailAction} className="space-y-2">
              <input name="to" type="email" required className="input" placeholder="you@example.com" defaultValue={actor.email.includes("@") ? actor.email : ""} />
              <p className="hint">Uses the saved SMTP settings. Save changes first.</p>
              <SubmitButton className="btn" pendingText="Sending…">Send test email</SubmitButton>
            </ActionForm>
          </Card>
          <Card title="Mailbox polling">
            <KeyValues
              items={[
                ["Status", m.imap_enabled ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>],
                ["Last poll", m.imap_last_poll_at ? formatDateTime(m.imap_last_poll_at, tz) : "Never"],
                ["Last error", m.imap_last_error ? <span className="prose-plain text-red-700">{m.imap_last_error}</span> : "None"],
              ]}
            />
          </Card>
          <Card title="Outbox totals">
            <KeyValues items={OUTBOX_STATUSES.map((s) => [s[0].toUpperCase() + s.slice(1), counts[s] ?? 0])} />
          </Card>
        </div>
      </div>

      <h2 className="mt-8 mb-3">Outbox</h2>
      <form method="get" className="card mb-3 flex flex-wrap items-center gap-2 p-3">
        <select name="status" defaultValue={status} className="input w-auto">
          <option value="">Any status</option>
          {OUTBOX_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
        <button className="btn btn-primary">Filter</button>
        {status && (
          <Link href="/admin/email" className="text-sm">
            Clear
          </Link>
        )}
        <span className="ml-auto text-xs text-slate-500">Latest 200 messages</span>
      </form>
      {outbox.length === 0 ? (
        <EmptyState title="No messages">{status ? "No messages have this status." : "Nothing has been sent yet."}</EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>To</th>
                <th>Subject</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Error</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {outbox.map((o) => (
                <tr key={o.id}>
                  <td className="whitespace-nowrap text-xs text-slate-500">
                    <When value={o.created_at} timeZone={tz} />
                    {o.sent_at && <div>sent {formatDateTime(o.sent_at, tz)}</div>}
                  </td>
                  <td className="text-sm">{o.to_address}</td>
                  <td className="max-w-sm text-sm">{o.subject}</td>
                  <td>
                    <Badge tone={STATUS_TONE[o.status] ?? "gray"}>{o.status}</Badge>
                  </td>
                  <td className="text-center tabular-nums">{o.attempts}</td>
                  <td className="max-w-xs text-xs break-words text-red-700">{o.last_error ?? ""}</td>
                  <td>
                    {o.status === "failed" && (
                      <ActionForm action={retryOutboxAction.bind(null, o.id)}>
                        <SubmitButton className="btn btn-sm">Retry</SubmitButton>
                      </ActionForm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
