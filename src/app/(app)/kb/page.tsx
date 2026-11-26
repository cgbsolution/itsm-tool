import Link from "next/link"
import { requireActor, can } from "@/lib/auth/session"
import { kbCategories, listArticles } from "@/lib/kb/queries"
import { KB_STATUSES, KB_STATUS_LABELS } from "@/lib/kb/service"
import { markdownExcerpt } from "@/lib/kb/markdown"
import { EmptyState, PageHeader, Pagination, When, qs } from "@/components/ui"
import { KbStatusBadge, VisibilityBadge } from "./parts"

export const metadata = { title: "Knowledge base" }

type SP = Record<string, string | undefined>

export default async function KbPage({ searchParams }: { searchParams: Promise<SP> }) {
  const actor = await requireActor()
  const sp = await searchParams
  const writer = can(actor, "kb.write")
  const staff = can(actor, "ticket.view_all")
  const [{ rows, total, page, pageSize }, categories] = await Promise.all([
    listArticles(actor, { q: sp.q, category: sp.category, status: sp.status, tag: sp.tag, page: Number(sp.page) || 1 }),
    kbCategories(actor),
  ])
  const base: SP = { q: sp.q, category: sp.category, status: sp.status, tag: sp.tag }
  const filtered = !!(sp.q || sp.category || sp.status || sp.tag)
  const tz = actor.tenant.timezone

  return (
    <>
      <PageHeader
        title="Knowledge base"
        subtitle={writer ? "Articles in every status" : staff ? "How-to guides and known fixes, including internal notes for the IT team" : "How-to guides and answers to common questions"}
        actions={
          <>
            {can(actor, "kb.publish") && (
              <Link className="btn" href="/kb/categories">
                Categories
              </Link>
            )}
            {writer && (
              <Link className="btn btn-primary" href="/kb/new">
                New article
              </Link>
            )}
          </>
        }
      />

      <form method="get" className="card mb-4 grid gap-2 p-3 sm:grid-cols-[1fr_auto_auto_auto]" role="search">
        <input name="q" type="search" defaultValue={sp.q} placeholder="Search articles, e.g. reset password" className="input" aria-label="Search" />
        <select name="category" defaultValue={sp.category ?? ""} className="input" aria-label="Category">
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {writer ? (
          <select name="status" defaultValue={sp.status ?? ""} className="input" aria-label="Status">
            <option value="">Any status</option>
            {KB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {KB_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        ) : (
          <span className="hidden sm:block" />
        )}
        <div className="flex gap-2">
          {sp.tag && <input type="hidden" name="tag" value={sp.tag} />}
          <button className="btn btn-primary">Search</button>
          {filtered && (
            <Link className="btn btn-ghost" href="/kb">
              Clear
            </Link>
          )}
        </div>
      </form>

      {sp.tag && (
        <p className="mb-3 text-sm text-slate-600">
          Tagged <span className="badge bg-slate-100 text-slate-700">{sp.tag}</span>{" "}
          <Link href={`/kb${qs(base, { tag: undefined })}`} className="text-xs">
            remove
          </Link>
        </p>
      )}

      {!filtered && categories.some((c) => c.articles > 0) && (
        <div className="mb-4 flex flex-wrap gap-2">
          {categories
            .filter((c) => c.articles > 0)
            .map((c) => (
              <Link key={c.id} href={`/kb?category=${c.id}`} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-sm text-slate-700 no-underline hover:border-slate-300 hover:no-underline">
                {c.name} <span className="text-xs text-slate-400">{c.articles}</span>
              </Link>
            ))}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title={filtered ? "No articles match" : "No articles yet"}
          action={
            writer && !filtered ? (
              <Link className="btn btn-primary" href="/kb/new">
                Write the first article
              </Link>
            ) : undefined
          }
        >
          {filtered ? "Try other words, or fewer filters." : writer ? "Articles you write start as drafts; a publisher makes them visible." : "Check back later, or raise a ticket."}
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {rows.map((a) => {
            const votes = a.helpful_yes + a.helpful_no
            return (
              <li key={a.id} className="card card-body">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/kb/${a.id}`} className="font-medium text-slate-900">
                    {a.title}
                  </Link>
                  <span className="font-mono text-xs text-slate-400">{a.number}</span>
                  {a.status !== "published" && <KbStatusBadge status={a.status} />}
                  {(staff || writer) && a.visibility === "internal" && <VisibilityBadge visibility={a.visibility} />}
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-slate-600">{a.summary || markdownExcerpt(a.body, 220) || <span className="muted">No content yet.</span>}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                  {a.category_name && <span>{a.category_name}</span>}
                  <span>
                    Updated <When value={a.updated_at} timeZone={tz} />
                  </span>
                  <span>{a.views} views</span>
                  {votes > 0 && <span>{Math.round((a.helpful_yes / votes) * 100)}% found it helpful</span>}
                  {a.tags.slice(0, 6).map((t) => (
                    <Link key={t} href={`/kb${qs(base, { tag: t, page: undefined })}`} className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600 no-underline hover:no-underline">
                      {t}
                    </Link>
                  ))}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <Pagination page={page} pageSize={pageSize} total={total} href={(p) => `/kb${qs(base, { page: p })}`} />
    </>
  )
}
