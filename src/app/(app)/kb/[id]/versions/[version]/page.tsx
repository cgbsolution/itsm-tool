import Link from "next/link"
import { notFound } from "next/navigation"
import { requirePermission } from "@/lib/auth/session"
import { AppError } from "@/lib/errors"
import { getArticleVersion } from "@/lib/kb/queries"
import { renderMarkdown } from "@/lib/kb/markdown"
import { formatDateTime } from "@/lib/format"
import { Card, PageHeader } from "@/components/ui"

export const metadata = { title: "Article version" }

export default async function ArticleVersionPage({ params }: { params: Promise<{ id: string; version: string }> }) {
  const actor = await requirePermission("kb.write")
  const { id, version } = await params
  let v
  try {
    v = await getArticleVersion(actor, id, Number(version))
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  const tz = actor.tenant.timezone
  return (
    <>
      <PageHeader
        back={{ href: `/kb/${id}`, label: `${v.number} (current version ${v.current_version})` }}
        title={v.title}
        subtitle={`Version ${v.version} · saved ${formatDateTime(v.created_at, tz)} by ${v.edited_by_name ?? "System"}`}
      />
      {v.version !== v.current_version && (
        <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
          You are looking at an older version.{" "}
          <Link href={`/kb/${id}`}>Open the current version</Link>.
        </p>
      )}
      <Card>
        {v.summary && <p className="prose-plain mb-3 border-b border-slate-100 pb-3 text-slate-600">{v.summary}</p>}
        {/* safe: renderMarkdown escapes all HTML first and allow-lists URLs */}
        <div className="md text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: renderMarkdown(v.body) }} />
      </Card>
      <details className="card mt-4">
        <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">Markdown source</summary>
        <pre className="prose-plain overflow-x-auto border-t border-slate-100 p-4 font-mono text-xs">{v.body}</pre>
      </details>
    </>
  )
}
