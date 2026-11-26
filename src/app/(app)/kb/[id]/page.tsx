import type { ReactNode } from "react"
import Link from "next/link"
import { headers } from "next/headers"
import { notFound } from "next/navigation"
import { requireActor, can } from "@/lib/auth/session"
import { AppError } from "@/lib/errors"
import { articleFiles, articleVersions, getArticle, linkedTickets, myVote } from "@/lib/kb/queries"
import { articleActions, recordView } from "@/lib/kb/service"
import { renderMarkdown } from "@/lib/kb/markdown"
import { bytes, formatDateTime } from "@/lib/format"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, KeyValues, PageHeader, StatusBadge, When } from "@/components/ui"
import { articleStatusAction, linkTicketAction, unlinkTicketAction, voteAction } from "../actions"
import { KbStatusBadge, VisibilityBadge } from "../parts"

async function load(key: string) {
  const actor = await requireActor()
  try {
    return { actor, article: await getArticle(actor, decodeURIComponent(key)) }
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  try {
    const { article } = await load((await params).id)
    return { title: `${article.number} ${article.title}` }
  } catch {
    return { title: "Knowledge article" }
  }
}

export default async function ArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { actor, article: a } = await load((await params).id)
  // count real page views, not re-renders after an action on this page
  if (!(await headers()).get("next-action")) await recordView(actor, a.id)

  const writer = can(actor, "kb.write")
  const staff = can(actor, "ticket.view_all")
  const worker = can(actor, "ticket.work")
  const [files, versions, tickets, vote] = await Promise.all([articleFiles(actor, a.id), articleVersions(actor, a.id), linkedTickets(actor, a.id), myVote(actor, a.id)])
  const actions = articleActions(actor, a.status)
  const tz = actor.tenant.timezone
  const votes = a.helpful_yes + a.helpful_no
  const attachments = files.filter((f) => !f.content_type.startsWith("image/") || !a.body.includes(f.id))

  return (
    <>
      <PageHeader
        back={{ href: "/kb", label: "Knowledge base" }}
        title={a.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{a.number}</span>
            <KbStatusBadge status={a.status} />
            {(staff || writer) && <VisibilityBadge visibility={a.visibility} />}
            {a.category_name && <Link href={`/kb?category=${a.category_id}`}>{a.category_name}</Link>}
            <span className="text-xs">
              Updated <When value={a.updated_at} timeZone={tz} />
              {a.author_name ? ` · by ${a.author_name}` : ""}
            </span>
          </span>
        }
        actions={
          writer && (
            <Link className="btn" href={`/kb/${a.id}/edit`}>
              Edit
            </Link>
          )
        }
      />

      {a.status !== "published" && (
        <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
          {a.status === "retired" ? "This article is retired and hidden from readers." : "This article is not published yet; only writers can see it."}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-4">
          <Card>
            {a.summary && <p className="prose-plain mb-3 border-b border-slate-100 pb-3 text-slate-600">{a.summary}</p>}
            {a.body.trim() ? (
              // safe: renderMarkdown escapes all HTML first and allow-lists link and image URLs (src/lib/kb/markdown.ts)
              <div className="md text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: renderMarkdown(a.body) }} />
            ) : (
              <p className="muted text-sm">This article has no content yet.</p>
            )}
          </Card>

          {attachments.length > 0 && (
            <Card title={`Attachments (${attachments.length})`}>
              <ul className="space-y-1 text-sm">
                {attachments.map((f) => (
                  <li key={f.id} className="flex items-center justify-between gap-2">
                    {f.storage_key ? <a href={`/api/files/${f.id}`} className="truncate">{f.file_name}</a> : <span className="truncate text-slate-500">{f.file_name} (not migrated)</span>}
                    <span className="shrink-0 text-xs text-slate-400">{bytes(f.size_bytes)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {a.status === "published" && (
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-slate-800">Was this helpful?</p>
                  <p className="text-xs text-slate-500">
                    {votes ? `${a.helpful_yes} of ${votes} ${votes === 1 ? "person" : "people"} found this helpful` : "Be the first to rate this article."}
                    {vote !== null && ` · You said ${vote ? "yes" : "no"}; you can change your answer.`}
                  </p>
                </div>
                <div className="flex gap-2">
                  <ActionForm action={voteAction.bind(null, a.id, true)}>
                    <SubmitButton className={vote === true ? "btn btn-primary" : "btn"}>Yes</SubmitButton>
                  </ActionForm>
                  <ActionForm action={voteAction.bind(null, a.id, false)}>
                    <SubmitButton className={vote === false ? "btn btn-primary" : "btn"}>No</SubmitButton>
                  </ActionForm>
                </div>
              </div>
            </Card>
          )}
        </div>

        <aside className="space-y-4">
          {actions.length > 0 && (
            <Card title="Workflow">
              <div className="space-y-2">
                {actions.map((t) => (
                  <ActionForm
                    key={t.action}
                    action={articleStatusAction.bind(null, a.id, t.action)}
                    confirm={t.action === "retire" ? "Retire this article? Readers will no longer see it." : t.action === "redraft" ? "Unpublish this article? Readers will no longer see it." : undefined}
                  >
                    <SubmitButton className={`${t.tone === "primary" ? "btn btn-primary" : t.tone === "danger" ? "btn btn-danger" : "btn"} w-full`}>{t.label}</SubmitButton>
                  </ActionForm>
                ))}
              </div>
              {a.status === "review" && !can(actor, "kb.publish") && <p className="hint">Waiting for a publisher to review it.</p>}
            </Card>
          )}

          <Card title="Details">
            <KeyValues
              items={[
                ["Number", <span key="n" className="font-mono text-xs">{a.number}</span>],
                ["Status", <KbStatusBadge key="s" status={a.status} />],
                ...(staff || writer ? ([["Visibility", <VisibilityBadge key="v" visibility={a.visibility} />]] as [string, ReactNode][]) : []),
                ["Category", a.category_name],
                [
                  "Tags",
                  a.tags.length ? (
                    <span key="t" className="flex flex-wrap gap-1">
                      {a.tags.map((t) => (
                        <Link key={t} href={`/kb?tag=${encodeURIComponent(t)}`} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 no-underline hover:no-underline">
                          {t}
                        </Link>
                      ))}
                    </span>
                  ) : null,
                ],
                ["Version", String(a.version)],
                ["Updated", formatDateTime(a.updated_at, tz)],
                ["Author", a.author_name],
                ...(a.editor_name && a.editor_name !== a.author_name ? ([["Last edited by", a.editor_name]] as [string, string][]) : []),
                ["Published", a.published_at ? formatDateTime(a.published_at, tz) : null],
                ["Views", String(a.views)],
              ]}
            />
          </Card>

          {staff && (
            <Card title={`Linked tickets (${tickets.length})`}>
              <ul className="space-y-1.5 text-sm">
                {tickets.map((t) => (
                  <li key={t.ticket_id} className="flex items-start justify-between gap-2">
                    <span className="min-w-0">
                      <Link href={`/tickets/${t.number}`} className="font-mono text-xs">
                        {t.number}
                      </Link>{" "}
                      <span className="text-slate-700">{t.subject}</span>
                      <span className="ml-1 inline-block align-middle">
                        <StatusBadge status={t.status} />
                      </span>
                    </span>
                    {worker && (
                      <ActionForm action={unlinkTicketAction.bind(null, a.id, t.ticket_id)}>
                        <button className="text-xs text-slate-400 hover:text-red-600" aria-label={`Unlink ${t.number}`}>
                          ✕
                        </button>
                      </ActionForm>
                    )}
                  </li>
                ))}
                {tickets.length === 0 && <li className="text-slate-500">None</li>}
              </ul>
              {worker && (
                <ActionForm action={linkTicketAction.bind(null, a.id)} resetOnSuccess className="mt-3 flex gap-2">
                  <input name="ticket" className="input" placeholder="Ticket number, e.g. INC0001001" required maxLength={40} aria-label="Ticket number" />
                  <SubmitButton className="btn">Link</SubmitButton>
                </ActionForm>
              )}
            </Card>
          )}

          {writer && versions.length > 0 && (
            <Card title="Version history">
              <ol className="space-y-1.5 text-sm">
                {versions.slice(0, 30).map((v) => (
                  <li key={v.version} className="flex items-baseline justify-between gap-2">
                    {v.version === a.version ? (
                      <span className="font-medium">v{v.version} (current)</span>
                    ) : (
                      <Link href={`/kb/${a.id}/versions/${v.version}`}>v{v.version}</Link>
                    )}
                    <span className="truncate text-xs text-slate-500">
                      {v.edited_by_name ?? "System"} · <When value={v.created_at} timeZone={tz} />
                    </span>
                  </li>
                ))}
              </ol>
              {versions.length > 30 && <p className="hint">Showing the latest 30 of {versions.length} versions.</p>}
            </Card>
          )}
        </aside>
      </div>
    </>
  )
}
