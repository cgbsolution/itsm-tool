/** Read side of the knowledge base: search, article detail, versions, links, files, categories. */
import { q, q1, Params, isUuid } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { notFound } from "@/lib/errors"
import { canReadArticle, isKbStatus, readableSql, type ArticleRow } from "@/lib/kb/service"

export type ArticleFilters = { q?: string; category?: string; status?: string; tag?: string; page?: number; pageSize?: number }

export type ArticleListRow = Pick<
  ArticleRow,
  "id" | "number" | "title" | "summary" | "body" | "status" | "visibility" | "tags" | "updated_at" | "published_at" | "views" | "helpful_yes" | "helpful_no"
> & { category_name: string | null; author_name: string | null; rank: number; total: number }

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c)

/**
 * Full-text search ranked with ts_rank(websearch_to_tsquery('simple', q)), with an
 * ilike fallback (substrings, partial words), category / tag filters and pagination.
 * Writers (kb.write) may filter by status; everyone else only sees what they may read.
 */
export async function listArticles(actor: Actor, f: ArticleFilters) {
  const p = new Params()
  const where = [`a.tenant_id = ${p.add(actor.tenantId)}`, readableSql(actor)]
  let rank = "0::real"
  const text = f.q?.trim().slice(0, 200)
  if (text) {
    const tq = p.add(text)
    const like = p.add(`%${likeEscape(text)}%`)
    where.push(
      `(a.search @@ websearch_to_tsquery('simple', ${tq}) or a.title ilike ${like} or a.summary ilike ${like} or a.body ilike ${like}
        or upper(a.number) = upper(${tq}) or lower(${tq}) = any(a.tags))`
    )
    rank = `ts_rank(a.search, websearch_to_tsquery('simple', ${tq})) + case when a.title ilike ${like} then 0.5 else 0 end`
  }
  if (f.category && isUuid(f.category)) where.push(`a.category_id = ${p.add(f.category)}`)
  if (f.tag?.trim()) where.push(`${p.add(f.tag.trim().toLowerCase())} = any(a.tags)`)
  if (actor.permissions.has("kb.write") && isKbStatus(f.status)) where.push(`a.status = ${p.add(f.status)}`)
  const pageSize = Math.min(Math.max(f.pageSize ?? 20, 5), 100)
  const page = Math.max(f.page ?? 1, 1)
  const rows = await q<ArticleListRow>(
    `select a.id, a.number, a.title, a.summary, left(a.body, 600) as body, a.status, a.visibility, a.tags, a.updated_at, a.published_at,
            a.views, a.helpful_yes, a.helpful_no, c.name as category_name, u.full_name as author_name,
            ${rank} as rank, count(*) over () as total
       from kb_articles a
       left join kb_categories c on c.id = a.category_id
       left join users u on u.id = a.author_id
      where ${where.join(" and ")}
      order by ${text ? "rank desc, " : ""}a.updated_at desc
      limit ${pageSize} offset ${(page - 1) * pageSize}`,
    p.values
  )
  return { rows, total: rows[0]?.total ?? 0, page, pageSize }
}

export type ArticleDetail = ArticleRow & { category_name: string | null; author_name: string | null; editor_name: string | null }

/** An article by id or number (KB0001001), if the actor may read it. */
export async function getArticle(actor: Actor, key: string): Promise<ArticleDetail> {
  const byId = isUuid(key)
  if (!byId && !/^[A-Za-z]{1,10}\d{1,12}$/.test(key)) throw notFound("Article not found")
  const a = await q1<ArticleDetail>(
    `select a.*, c.name as category_name, au.full_name as author_name,
            (select u.full_name from kb_article_versions v left join users u on u.id = v.edited_by
              where v.article_id = a.id order by v.version desc limit 1) as editor_name
       from kb_articles a
       left join kb_categories c on c.id = a.category_id
       left join users au on au.id = a.author_id
      where a.tenant_id = $1 and ${byId ? "a.id = $2" : "upper(a.number) = upper($2)"}`,
    [actor.tenantId, key]
  )
  if (!a || !canReadArticle(actor, a)) throw notFound("Article not found")
  return a
}

export async function articleVersions(actor: Actor, articleId: string) {
  if (!actor.permissions.has("kb.write")) return []
  return q<{ version: number; title: string; created_at: Date; edited_by_name: string | null }>(
    `select v.version, v.title, v.created_at, u.full_name as edited_by_name
       from kb_article_versions v
       join kb_articles a on a.id = v.article_id and a.tenant_id = $2
       left join users u on u.id = v.edited_by
      where v.article_id = $1
      order by v.version desc`,
    [articleId, actor.tenantId]
  )
}

export async function getArticleVersion(actor: Actor, articleId: string, version: number) {
  if (!actor.permissions.has("kb.write") || !isUuid(articleId) || !Number.isInteger(version)) throw notFound("Version not found")
  const v = await q1<{ version: number; title: string; summary: string | null; body: string; created_at: Date; edited_by_name: string | null; number: string; current_version: number }>(
    `select v.version, v.title, v.summary, v.body, v.created_at, u.full_name as edited_by_name, a.number, a.version as current_version
       from kb_article_versions v
       join kb_articles a on a.id = v.article_id and a.tenant_id = $2
       left join users u on u.id = v.edited_by
      where v.article_id = $1 and v.version = $3`,
    [articleId, actor.tenantId, version]
  )
  if (!v) throw notFound("Version not found")
  return v
}

/** Tickets linked to an article (IT staff only). */
export async function linkedTickets(actor: Actor, articleId: string) {
  if (!actor.permissions.has("ticket.view_all")) return []
  return q<{ ticket_id: string; number: string; subject: string; status: string; ticket_type: string; linked_at: Date; linked_by_name: string | null }>(
    `select t.id as ticket_id, t.number, t.subject, t.status, t.ticket_type, k.created_at as linked_at, u.full_name as linked_by_name
       from kb_article_tickets k
       join tickets t on t.id = k.ticket_id and t.tenant_id = $2
       left join users u on u.id = k.linked_by
      where k.article_id = $1
      order by k.created_at desc`,
    [articleId, actor.tenantId]
  )
}

export async function articleFiles(actor: Actor, articleId: string) {
  return q<{ id: string; file_name: string; content_type: string; size_bytes: number; created_at: Date; storage_key: string | null }>(
    `select id, file_name, content_type, size_bytes, created_at, storage_key
       from files where tenant_id = $1 and entity_type = 'kb_article' and entity_id = $2 order by created_at`,
    [actor.tenantId, articleId]
  )
}

export async function myVote(actor: Actor, articleId: string): Promise<boolean | null> {
  const v = await q1<{ helpful: boolean }>("select helpful from kb_votes where article_id = $1 and user_id = $2", [articleId, actor.id])
  return v ? v.helpful : null
}

export async function kbCategories(actor: Actor) {
  return q<{ id: string; name: string; sort_order: number; articles: number }>(
    `select c.id, c.name, c.sort_order, count(a.id) as articles
       from kb_categories c
       left join kb_articles a on a.category_id = c.id and a.tenant_id = c.tenant_id and ${readableSql(actor)}
      where c.tenant_id = $1
      group by c.id
      order by c.sort_order, lower(c.name)`,
    [actor.tenantId]
  )
}
