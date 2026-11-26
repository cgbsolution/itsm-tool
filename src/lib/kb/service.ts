/**
 * Knowledge base service: the only code that writes kb_* tables. Every function
 * re-checks permissions and filters on the actor's tenant.
 *
 * Who reads what
 * - kb.write (writers):        every article, any status and visibility
 * - ticket.view_all (IT staff): published articles, public and internal
 * - everyone else:             published public articles
 *
 * Workflow: draft → review (kb.write) → published / retired (kb.publish).
 * Every content save bumps `version` and stores a row in kb_article_versions.
 */
import { z } from "zod"
import { q, q1, exec, tx, isUuid, isUniqueViolation, type Db } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import type { Permission } from "@/lib/auth/permissions"
import { actorId } from "@/lib/auth/system"
import { AppError, conflict, forbidden, notFound } from "@/lib/errors"
import { parse } from "@/lib/validate"
import { audit } from "@/lib/audit"
import { removeStored, saveUploads, type SavedFile } from "@/lib/files/storage"

export const KB_STATUSES = ["draft", "review", "published", "retired"] as const
export type KbStatus = (typeof KB_STATUSES)[number]
export const KB_STATUS_LABELS: Record<KbStatus, string> = { draft: "Draft", review: "In review", published: "Published", retired: "Retired" }
export const KB_VISIBILITIES = ["internal", "public"] as const
export type KbVisibility = (typeof KB_VISIBILITIES)[number]
export const KB_VISIBILITY_LABELS: Record<KbVisibility, string> = { internal: "Internal (IT staff)", public: "Public (everyone)" }

export function isKbStatus(v: unknown): v is KbStatus {
  return typeof v === "string" && (KB_STATUSES as readonly string[]).includes(v)
}

export type ArticleRow = {
  id: string
  tenant_id: string
  number: string
  title: string
  summary: string | null
  body: string
  category_id: string | null
  status: KbStatus
  visibility: KbVisibility
  tags: string[]
  author_id: string | null
  published_at: Date | null
  version: number
  views: number
  helpful_yes: number
  helpful_no: number
  created_at: Date
  updated_at: Date
}

/* ── access ────────────────────────────────────────────────────────────── */

export function canReadArticle(actor: Pick<Actor, "permissions">, a: { status: string; visibility: string }): boolean {
  if (actor.permissions.has("kb.write")) return true
  return a.status === "published" && (a.visibility === "public" || actor.permissions.has("ticket.view_all"))
}

/** SQL condition on kb_articles (alias `a`) for the articles the actor may read. Constant text, no parameters. */
export function readableSql(actor: Pick<Actor, "permissions">, alias = "a"): string {
  if (actor.permissions.has("kb.write")) return "true"
  if (actor.permissions.has("ticket.view_all")) return `${alias}.status = 'published'`
  return `${alias}.status = 'published' and ${alias}.visibility = 'public'`
}

function need(actor: Actor, perm: Permission, message?: string) {
  if (!actor.permissions.has(perm)) throw forbidden(message)
}

function run<T>(db: Db | undefined, fn: (db: Db) => Promise<T>): Promise<T> {
  return db ? fn(db) : tx(fn)
}

async function lockArticle(db: Db, actor: Actor, id: string): Promise<ArticleRow> {
  if (!isUuid(id)) throw notFound("Article not found")
  const a = await q1<ArticleRow>("select * from kb_articles where id = $1 and tenant_id = $2 for update", [id, actor.tenantId], db)
  if (!a || !canReadArticle(actor, a)) throw notFound("Article not found")
  return a
}

const auditActor = (actor: Actor) => (actor.isSystem ? null : { id: actor.id, email: actor.email })

/* ── articles ──────────────────────────────────────────────────────────── */

const articleSchema = z.object({
  title: z.string().trim().min(1, "Give the article a title").max(300, "Keep the title under 300 characters"),
  summary: z.string().trim().max(1000, "Keep the summary under 1,000 characters").nullish(),
  body: z.string().max(200_000, "The article is too long (200,000 characters at most)"),
  categoryId: z.string().refine((v) => isUuid(v), "Invalid category").nullish(),
  tags: z.array(z.string().max(40, "Keep each tag under 40 characters")).max(20, "Use at most 20 tags").optional(),
  visibility: z.enum(KB_VISIBILITIES, { message: "Choose who can read the article" }),
})
export type ArticleInput = z.input<typeof articleSchema>

/** "VPN, Remote access ,vpn" → ["vpn", "remote access"]. */
export function parseTags(raw: string | null | undefined): string[] {
  const out: string[] = []
  for (const part of String(raw ?? "").split(/[,;\n]/)) {
    const t = part.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40)
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

async function checkCategory(db: Db, tenantId: string, categoryId: string | null | undefined): Promise<string | null> {
  if (!categoryId) return null
  const c = await q1("select 1 from kb_categories where id = $1 and tenant_id = $2", [categoryId, tenantId], db)
  if (!c) throw new AppError("That category does not exist")
  return categoryId
}

async function writeVersion(db: Db, actor: Actor, a: ArticleRow) {
  await exec(
    "insert into kb_article_versions (article_id, version, title, summary, body, edited_by) values ($1, $2, $3, $4, $5, $6)",
    [a.id, a.version, a.title, a.summary, a.body, actorId(actor)],
    db
  )
}

export async function createArticle(actor: Actor, raw: ArticleInput, db?: Db): Promise<ArticleRow> {
  need(actor, "kb.write", "You cannot write knowledge articles")
  const input = parse(articleSchema, raw)
  return run(db, async (c) => {
    const categoryId = await checkCategory(c, actor.tenantId, input.categoryId)
    const n = await q1<{ n: string }>("select next_number($1, 'kb', 'KB') as n", [actor.tenantId], c)
    const a = await q1<ArticleRow>(
      `insert into kb_articles (tenant_id, number, title, summary, body, category_id, visibility, tags, author_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [actor.tenantId, n!.n, input.title, input.summary || null, input.body, categoryId, input.visibility, input.tags ?? [], actorId(actor)],
      c
    )
    await writeVersion(c, actor, a!)
    return a!
  })
}

/** Saves new content. `expectedVersion` guards against overwriting someone else's edit. */
export async function updateArticle(actor: Actor, id: string, expectedVersion: number | undefined, raw: ArticleInput): Promise<ArticleRow> {
  need(actor, "kb.write", "You cannot edit knowledge articles")
  const input = parse(articleSchema, raw)
  return tx(async (c) => {
    const a = await lockArticle(c, actor, id)
    if (expectedVersion !== undefined && expectedVersion !== a.version) throw conflict("Someone else saved this article meanwhile. Reload it and apply your changes again.")
    const visibilityChanged = a.status === "published" && input.visibility !== a.visibility
    if (visibilityChanged && !actor.permissions.has("kb.publish")) {
      throw forbidden("Only a publisher can change who can read a published article")
    }
    const categoryId = await checkCategory(c, actor.tenantId, input.categoryId)
    const row = await q1<ArticleRow>(
      `update kb_articles set title = $3, summary = $4, body = $5, category_id = $6, visibility = $7, tags = $8,
              version = version + 1, updated_at = now()
        where id = $1 and tenant_id = $2 returning *`,
      [a.id, actor.tenantId, input.title, input.summary || null, input.body, categoryId, input.visibility, input.tags ?? []],
      c
    )
    await writeVersion(c, actor, row!)
    if (visibilityChanged) {
      await audit(
        { tenantId: actor.tenantId, actor: auditActor(actor), action: "kb.article_visibility_changed", entityType: "kb_article", entityId: a.id, summary: `${a.number}: ${a.visibility} → ${input.visibility}` },
        c
      )
    }
    return row!
  })
}

export type ArticleAction = "submit" | "withdraw" | "publish" | "retire" | "redraft"

const ARTICLE_ACTIONS: Record<ArticleAction, { from: KbStatus[]; to: KbStatus; perm: Permission; label: string; tone?: "primary" | "danger" }> = {
  submit: { from: ["draft"], to: "review", perm: "kb.write", label: "Submit for review", tone: "primary" },
  withdraw: { from: ["review"], to: "draft", perm: "kb.write", label: "Back to draft" },
  publish: { from: ["draft", "review", "retired"], to: "published", perm: "kb.publish", label: "Publish", tone: "primary" },
  retire: { from: ["draft", "review", "published"], to: "retired", perm: "kb.publish", label: "Retire", tone: "danger" },
  redraft: { from: ["published", "retired"], to: "draft", perm: "kb.publish", label: "Unpublish to draft" },
}

/** Workflow buttons the actor may use on an article in this status. */
export function articleActions(actor: Pick<Actor, "permissions">, status: string) {
  return (Object.entries(ARTICLE_ACTIONS) as [ArticleAction, (typeof ARTICLE_ACTIONS)[ArticleAction]][])
    .filter(([, t]) => t.from.includes(status as KbStatus) && actor.permissions.has(t.perm))
    .map(([action, t]) => ({ action, label: t.label, tone: t.tone, to: t.to }))
}

export async function setArticleStatus(actor: Actor, id: string, action: string): Promise<ArticleRow> {
  const t = ARTICLE_ACTIONS[action as ArticleAction]
  if (!t) throw new AppError("Unknown action")
  need(actor, t.perm, t.perm === "kb.publish" ? "Only publishers can do that" : undefined)
  return tx(async (c) => {
    const a = await lockArticle(c, actor, id)
    if (!t.from.includes(a.status)) throw new AppError(`The article is ${KB_STATUS_LABELS[a.status].toLowerCase()}; that action is not available now`)
    const row = await q1<ArticleRow>(
      `update kb_articles set status = $3, published_at = case when $3 = 'published' then now() else published_at end, updated_at = now()
        where id = $1 and tenant_id = $2 returning *`,
      [a.id, actor.tenantId, t.to],
      c
    )
    if (action === "publish" || action === "retire" || action === "redraft") {
      const verb = action === "publish" ? "published" : action === "retire" ? "retired" : "unpublished"
      await audit(
        {
          tenantId: actor.tenantId,
          actor: auditActor(actor),
          action: `kb.article_${verb}`,
          entityType: "kb_article",
          entityId: a.id,
          summary: `${a.number}: ${a.title}`.slice(0, 300),
          data: { from: a.status, to: t.to, version: a.version, visibility: a.visibility },
        },
        c
      )
    }
    return row!
  })
}

/** Counts one view (only for articles the actor may read). */
export async function recordView(actor: Actor, id: string): Promise<void> {
  if (!isUuid(id)) return
  await exec(`update kb_articles a set views = views + 1 where a.id = $1 and a.tenant_id = $2 and ${readableSql(actor)}`, [id, actor.tenantId])
}

/** "Was this helpful?": one vote per user, changeable. Returns the new counters. */
export async function voteArticle(actor: Actor, id: string, helpful: boolean): Promise<{ helpful_yes: number; helpful_no: number }> {
  if (actor.isSystem) throw forbidden()
  return tx(async (c) => {
    const a = await lockArticle(c, actor, id)
    if (a.status !== "published") throw new AppError("Only published articles can be rated")
    await exec(
      `insert into kb_votes (article_id, user_id, helpful) values ($1, $2, $3)
       on conflict (article_id, user_id) do update set helpful = excluded.helpful, created_at = now()`,
      [a.id, actor.id, helpful],
      c
    )
    const counts = await q1<{ helpful_yes: number; helpful_no: number }>(
      `update kb_articles set
              helpful_yes = (select count(*) from kb_votes where article_id = $1 and helpful),
              helpful_no  = (select count(*) from kb_votes where article_id = $1 and not helpful)
        where id = $1 and tenant_id = $2 returning helpful_yes, helpful_no`,
      [a.id, actor.tenantId],
      c
    )
    return counts!
  })
}

/* ── tickets ───────────────────────────────────────────────────────────── */

export async function linkArticleToTicket(actor: Actor, articleId: string, ticketNumber: string): Promise<{ number: string }> {
  need(actor, "ticket.work", "Only the IT team can link articles to tickets")
  const number = ticketNumber.trim()
  if (!number) throw new AppError("Enter a ticket number")
  return tx(async (c) => {
    const a = await lockArticle(c, actor, articleId)
    const t = await q1<{ id: string; number: string }>(
      "select id, number from tickets where tenant_id = $1 and upper(number) = upper($2)",
      [actor.tenantId, number.slice(0, 40)],
      c
    )
    if (!t) throw new AppError(`There is no ticket ${number.slice(0, 40)}`)
    await exec(
      "insert into kb_article_tickets (article_id, ticket_id, linked_by) values ($1, $2, $3) on conflict do nothing",
      [a.id, t.id, actorId(actor)],
      c
    )
    return { number: t.number }
  })
}

export async function unlinkArticleFromTicket(actor: Actor, articleId: string, ticketId: string): Promise<void> {
  need(actor, "ticket.work")
  if (!isUuid(ticketId)) throw notFound()
  await tx(async (c) => {
    const a = await lockArticle(c, actor, articleId)
    await exec(
      "delete from kb_article_tickets k using tickets t where k.article_id = $1 and k.ticket_id = $2 and t.id = k.ticket_id and t.tenant_id = $3",
      [a.id, ticketId, actor.tenantId],
      c
    )
  })
}

/* ── attachments ───────────────────────────────────────────────────────── */

export async function addArticleFiles(actor: Actor, articleId: string, files: FormDataEntryValue[], db?: Db): Promise<SavedFile[]> {
  need(actor, "kb.write", "You cannot add files to articles")
  return run(db, async (c) => {
    const a = await lockArticle(c, actor, articleId)
    return saveUploads(files, { tenantId: actor.tenantId, entityType: "kb_article", entityId: a.id, uploadedBy: actorId(actor) }, c)
  })
}

export async function deleteArticleFile(actor: Actor, articleId: string, fileId: string): Promise<void> {
  need(actor, "kb.write", "You cannot remove files from articles")
  if (!isUuid(fileId) || !isUuid(articleId)) throw notFound("File not found")
  const f = await q1<{ storage_key: string | null }>(
    "delete from files where id = $1 and tenant_id = $2 and entity_type = 'kb_article' and entity_id = $3 returning storage_key",
    [fileId, actor.tenantId, articleId]
  )
  if (!f) throw notFound("File not found")
  await removeStored(f.storage_key)
}

/** Markdown for embedding an uploaded file (images inline, other files as a link). */
export function fileSnippet(f: { id: string; file_name: string; content_type: string }): string {
  const name = f.file_name.replace(/[[\]()\\\n\r]/g, "").trim() || "file"
  return f.content_type.startsWith("image/") ? `![${name}](/api/files/${f.id}?inline=1)` : `[${name}](/api/files/${f.id})`
}

/* ── categories ────────────────────────────────────────────────────────── */

function categoryName(raw: string | null | undefined): string {
  const name = String(raw ?? "").trim().replace(/\s+/g, " ")
  if (!name) throw new AppError("Give the category a name")
  if (name.length > 100) throw new AppError("Keep the name under 100 characters")
  return name
}

const duplicateCategory = (e: unknown) => (isUniqueViolation(e) ? new AppError("A category with that name already exists") : e)

export async function createKbCategory(actor: Actor, input: { name: string; sortOrder?: number }): Promise<string> {
  need(actor, "kb.publish", "Only publishers can manage knowledge categories")
  const name = categoryName(input.name)
  try {
    return await tx(async (c) => {
      const row = await q1<{ id: string }>(
        "insert into kb_categories (tenant_id, name, sort_order) values ($1, $2, $3) returning id",
        [actor.tenantId, name, input.sortOrder ?? 0],
        c
      )
      await audit({ tenantId: actor.tenantId, actor: auditActor(actor), action: "kb.category_created", entityType: "kb_category", entityId: row!.id, summary: name }, c)
      return row!.id
    })
  } catch (e) {
    throw duplicateCategory(e)
  }
}

export async function updateKbCategory(actor: Actor, id: string, input: { name: string; sortOrder?: number }): Promise<void> {
  need(actor, "kb.publish", "Only publishers can manage knowledge categories")
  if (!isUuid(id)) throw notFound("Category not found")
  const name = categoryName(input.name)
  try {
    await tx(async (c) => {
      const before = await q1<{ name: string }>("select name from kb_categories where id = $1 and tenant_id = $2 for update", [id, actor.tenantId], c)
      if (!before) throw notFound("Category not found")
      await exec("update kb_categories set name = $3, sort_order = $4 where id = $1 and tenant_id = $2", [id, actor.tenantId, name, input.sortOrder ?? 0], c)
      await audit(
        { tenantId: actor.tenantId, actor: auditActor(actor), action: "kb.category_updated", entityType: "kb_category", entityId: id, summary: before.name === name ? name : `${before.name} → ${name}` },
        c
      )
    })
  } catch (e) {
    throw duplicateCategory(e)
  }
}

export async function deleteKbCategory(actor: Actor, id: string): Promise<void> {
  need(actor, "kb.publish", "Only publishers can manage knowledge categories")
  if (!isUuid(id)) throw notFound("Category not found")
  await tx(async (c) => {
    const row = await q1<{ name: string }>("delete from kb_categories where id = $1 and tenant_id = $2 returning name", [id, actor.tenantId], c)
    if (!row) throw notFound("Category not found")
    await audit({ tenantId: actor.tenantId, actor: auditActor(actor), action: "kb.category_deleted", entityType: "kb_category", entityId: id, summary: row.name }, c)
  })
}

/* ── suggestions (for the ticket form) ─────────────────────────────────── */

export type ArticleSuggestion = { id: string; number: string; title: string; summary: string | null; rank: number }

const STOP_WORDS = new Set(
  "the and for with not this that from have are was were you your can cannot cant but has had been will would should could please when what how why who there they them our all any its into out get got also just after before since while then than very some need needs help issue problem hello thanks thank regards dear team working work does doesnt dont able unable".split(" ")
)

/**
 * Published knowledge articles the actor may read that match free text (for
 * example a ticket subject and description), best match first.
 *
 * - Visibility: published articles only; internal ones only for IT staff
 *   (`ticket.view_all`) and writers (`kb.write`), public ones for everyone.
 * - Matching: words of 3+ letters/digits (minus common filler words, up to 16)
 *   are OR-ed into a full-text query on the article's search vector (title >
 *   summary > body) and ranked with ts_rank. When nothing matches, the longest
 *   words are tried as substrings of the title and summary.
 * - Returns [] for empty text. Read-only; `limit` is clamped to 1..20.
 *
 * @example const hits = await suggestArticles(actor, `${subject}\n${description}`)
 */
export async function suggestArticles(actor: Actor, text: string, limit = 5): Promise<ArticleSuggestion[]> {
  const words = [...new Set((String(text ?? "").slice(0, 5000).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP_WORDS.has(w)))]
    .map((w) => w.slice(0, 40))
    .slice(0, 16)
  if (!words.length) return []
  const n = Math.min(Math.max(Math.trunc(limit) || 5, 1), 20)
  const visible = actor.permissions.has("ticket.view_all") || actor.permissions.has("kb.write") ? "" : "and a.visibility = 'public'"
  const hits = await q<ArticleSuggestion>(
    `select a.id, a.number, a.title, a.summary, ts_rank(a.search, query) as rank
       from kb_articles a, to_tsquery('simple', $2) query
      where a.tenant_id = $1 and a.status = 'published' ${visible} and a.search @@ query
      order by rank desc, a.helpful_yes - a.helpful_no desc, a.updated_at desc
      limit $3`,
    [actor.tenantId, words.join(" | "), n]
  )
  if (hits.length) return hits
  const longest = [...words].sort((x, y) => y.length - x.length).slice(0, 3).map((w) => `%${w.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`)
  return q<ArticleSuggestion>(
    `select a.id, a.number, a.title, a.summary, 0::real as rank
       from kb_articles a
      where a.tenant_id = $1 and a.status = 'published' ${visible}
        and (a.title ilike any($2::text[]) or a.summary ilike any($2::text[]))
      order by a.helpful_yes - a.helpful_no desc, a.updated_at desc
      limit $3`,
    [actor.tenantId, longest, n]
  )
}
