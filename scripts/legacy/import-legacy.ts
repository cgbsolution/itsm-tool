/**
 * Imports the old helpdesk (Supabase) data into this database.
 *
 *   npm run legacy:stage -- -DumpDir "<folder with .dump files>"   # restores dumps into a throwaway container
 *   npm run legacy:import -- --timezone Asia/Kolkata [--dry-run]
 *
 * Source: LEGACY_DATABASE_URL, or the URL written by stage-legacy.ps1 to data/legacy-staging-url.txt.
 * Target: DATABASE_URL.
 *
 * - Keeps the original UUIDs, so references stay intact and re-running is safe (rows that
 *   already exist are skipped).
 * - Passwords: bcrypt hashes from auth.users are carried over, so people keep their passwords.
 * - Personal-data minimisation: date of birth, home addresses, postal code and country are
 *   NOT imported (not needed for IT service management).
 * - Notifications (transient) and the AskMira connector tables are not imported.
 * - Attachment files live in Supabase Storage and are not in the dump: their records are
 *   imported and shown as "not migrated" until fetched (see docs/MIGRATION.md).
 * Prints counts only, never personal data.
 */
import "../_env"
import fs from "node:fs"
import pg from "pg"
import { pool, tx, q, q1, exec, type Db } from "@/lib/db"
import { migrate } from "@/lib/db/migrate"
import { createTenant, seedTenantDefaults } from "@/lib/tenants"
import { legacyStatus, type Status } from "@/lib/itsm/workflow"
import { classKeyForLegacyType, DEFAULT_CI_CLASSES } from "@/lib/cmdb/classes"
import { audit } from "@/lib/audit"
import { isValidTimeZone } from "@/lib/itsm/clock"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const DRY = process.argv.includes("--dry-run")
const TZ = arg("timezone") ?? "Asia/Kolkata"
if (!isValidTimeZone(TZ)) throw new Error(`Unknown time zone ${TZ}`)

function legacyUrl(): string {
  if (process.env.LEGACY_DATABASE_URL) return process.env.LEGACY_DATABASE_URL
  const f = "data/legacy-staging-url.txt"
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim()
  throw new Error("Set LEGACY_DATABASE_URL or run `npm run legacy:stage` first")
}

type Row = Record<string, any>
const counts: Record<string, number> = {}
const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n)

const LEVELS = ["low", "medium", "high"]
const PRIORITIES = ["low", "medium", "high", "critical"]
const level = (v: unknown) => (typeof v === "string" && LEVELS.includes(v.toLowerCase()) ? v.toLowerCase() : null)
const priority = (v: unknown) => (typeof v === "string" && PRIORITIES.includes(v.toLowerCase()) ? v.toLowerCase() : "medium")
const ROLES = ["user", "engineer", "admin", "superadmin"]
const CONDITIONS = ["new", "good", "fair", "poor", "damaged"]
const EMAIL = /^[^@\s]+@[^@\s]+$/

async function main() {
  const legacy = new pg.Pool({ connectionString: legacyUrl(), max: 2 })
  const L = async (sql: string, params: unknown[] = []) => (await legacy.query(sql, params)).rows as Row[]
  const tableExists = async (schema: string, table: string) =>
    (await L("select 1 from information_schema.tables where table_schema = $1 and table_name = $2", [schema, table])).length > 0

  await migrate()

  // ── read everything (the dataset is small; streaming is not needed) ──
  const hasTenants = await tableExists("public", "tenants")
  const tenants = hasTenants ? await L("select id, name, slug, status, created_at from public.tenants order by created_at") : []
  const hasAuth = await tableExists("auth", "users")
  const users = await L(
    `select p.*, ${hasAuth ? "a.encrypted_password, a.banned_until, a.deleted_at, a.last_sign_in_at" : "null as encrypted_password, null as banned_until, null as deleted_at, null as last_sign_in_at"}
       from public.users p ${hasAuth ? "left join auth.users a on a.id = p.id" : ""} order by p.created_at nulls first, p.id`
  )
  const orgs = await L("select * from public.organizations order by created_at nulls first")
  const tickets = await L("select * from public.tickets order by created_at nulls first, id")
  const messages = await L("select * from public.ticket_messages order by created_at nulls first")
  const activity = await L("select * from public.ticket_activity order by created_at nulls first")
  const assignments = await L("select * from public.ticket_assignments order by assigned_at nulls first")
  const attachments = await L("select * from public.ticket_attachments order by created_at nulls first")
  const links = (await tableExists("public", "ticket_links")) ? await L("select * from public.ticket_links") : []
  const assets = await L("select * from public.assets order by created_at nulls first, id")
  const details = await L("select * from public.asset_details order by created_at nulls first")
  const assetAssign = await L("select * from public.asset_assignments order by assigned_at nulls first")
  const assetTickets = await L("select * from public.asset_tickets")
  await legacy.end()

  const singleTenant = tenants.length === 1 ? tenants[0].id : null
  const tenantName = arg("tenant-name") ?? tenants[0]?.name
  if (!tenants.length && !tenantName) throw new Error("The old data has no tenants table: pass --tenant-name")

  await tx(async (db) => {
    // ── tenants ──
    const tenantIds: string[] = []
    if (tenants.length) {
      for (const t of tenants) {
        const exists = await q1("select 1 from tenants where id = $1", [t.id], db)
        if (!exists) {
          await createTenant(t.name, { id: t.id, slug: t.slug, timezone: TZ, slaProfile: "legacy" }, db)
          bump("tenants")
        } else {
          await seedTenantDefaults(db, t.id, { timezone: TZ, slaProfile: "legacy" })
        }
        if (t.status === "suspended") await exec("update tenants set status = 'suspended' where id = $1", [t.id], db)
        tenantIds.push(t.id)
      }
    } else {
      const existing = await q1<{ id: string }>("select id from tenants where lower(name) = lower($1)", [tenantName], db)
      tenantIds.push(existing?.id ?? (await createTenant(tenantName!, { timezone: TZ, slaProfile: "legacy" }, db)))
    }
    const tenantOf = (r: Row): string => r.tenant_id ?? singleTenant ?? tenantIds[0]

    // ── organisations ──
    for (const o of orgs) {
      const n = await exec(
        `insert into organizations (id, tenant_id, name, domain, status, created_at) values ($1, $2, $3, $4, $5, coalesce($6, now()))
         on conflict do nothing`,
        [o.id, tenantOf(o), o.name, o.domain || null, o.status === "inactive" ? "inactive" : "active", o.created_at],
        db
      )
      bump(n ? "organizations" : "organizations_skipped")
    }

    // ── people ──
    const userIds = new Set<string>()
    const seenEmails = new Set((await q<{ e: string }>("select lower(email) as e from users", [], db)).map((r) => r.e))
    let hrFieldsDropped = 0
    for (const u of users) {
      const already = await q1("select 1 from users where id = $1", [u.id], db)
      if (already) {
        userIds.add(u.id)
        bump("users_already_present")
        continue
      }
      let email = String(u.email ?? "").trim().toLowerCase()
      let status = u.deleted_at || (u.banned_until && new Date(u.banned_until) > new Date()) ? "disabled" : "active"
      if (!EMAIL.test(email) || seenEmails.has(email)) {
        email = `legacy-${String(u.id).slice(0, 8)}@invalid.local`
        status = "disabled"
        bump("users_without_usable_email")
      }
      seenEmails.add(email)
      const hash = typeof u.encrypted_password === "string" && /^\$2[aby]\$\d{2}\$/.test(u.encrypted_password) ? u.encrypted_password : null
      if (!hash) bump("users_without_password")
      if (u.date_of_birth || u.present_address || u.permanent_address || u.postal_code || u.country) hrFieldsDropped++
      await exec(
        `insert into users (id, tenant_id, email, full_name, role, status, password_hash, password_changed_at, phone, employee_id,
                            designation, department, location, organization_id, timezone, last_seen_at, last_login_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, case when $7::text is null then null else now() end, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                 coalesce($17, now()), coalesce($18, now()))`,
        [
          u.id, tenantOf(u), email, String(u.full_name ?? "").slice(0, 200), ROLES.includes(u.role) ? u.role : "user", status, hash,
          u.phone === null || u.phone === undefined ? null : String(u.phone), u.employee_id ?? null, u.designation ?? u.position ?? null,
          u.department ?? null, u.city ?? null, u.organization_id ?? null, u.timezone && isValidTimeZone(u.timezone) ? u.timezone : null,
          u.last_seen_at ?? null, u.last_sign_in_at ?? null, u.created_at, u.updated_at,
        ],
        db
      )
      userIds.add(u.id)
      bump("users")
    }
    counts.users_hr_fields_not_imported = hrFieldsDropped
    // managers were free text: link when it names exactly one person by email or name
    for (const u of users.filter((x) => x.manager && userIds.has(x.id))) {
      const m = await q<{ id: string }>(
        "select id from users where tenant_id = $1 and (lower(email) = lower($2) or lower(full_name) = lower($2)) limit 2",
        [tenantOf(u), String(u.manager).trim()],
        db
      )
      if (m.length === 1 && m[0].id !== u.id) {
        await exec("update users set manager_id = $2 where id = $1 and manager_id is null", [u.id, m[0].id], db)
        bump("managers_linked")
      }
    }
    // the IT team joins the default support group
    for (const tid of tenantIds) {
      await exec(
        `insert into group_members (group_id, user_id)
         select g.id, u.id from groups g join users u on u.tenant_id = g.tenant_id
          where g.tenant_id = $1 and g.name = 'Service Desk' and u.role in ('engineer', 'admin', 'superadmin') and u.status = 'active'
         on conflict do nothing`,
        [tid],
        db
      )
    }
    const known = (id: unknown): string | null => (typeof id === "string" && userIds.has(id) ? id : null)

    // ── categories: free text → the category tree (unknown names are added) ──
    const catCache = new Map<string, string>()
    async function categoryId(tenantId: string, cat: string | null, sub: string | null): Promise<{ id: string | null; cat: string | null; sub: string | null }> {
      const c = cat?.trim()
      if (!c) return { id: null, cat: null, sub: null }
      const pk = `${tenantId}|${c.toLowerCase()}`
      let parent = catCache.get(pk)
      if (!parent) {
        parent =
          (await q1<{ id: string }>("select id from ticket_categories where tenant_id = $1 and parent_id is null and lower(name) = lower($2)", [tenantId, c], db))?.id ??
          (await q1<{ id: string }>("insert into ticket_categories (tenant_id, name, sort_order) values ($1, $2, 900) returning id", [tenantId, c.slice(0, 100)], db))!.id
        catCache.set(pk, parent)
      }
      const s = sub?.trim()
      if (!s) return { id: parent, cat: c, sub: null }
      const sk = `${pk}|${s.toLowerCase()}`
      let child = catCache.get(sk)
      if (!child) {
        child =
          (await q1<{ id: string }>("select id from ticket_categories where parent_id = $1 and lower(name) = lower($2)", [parent, s], db))?.id ??
          (await q1<{ id: string }>("insert into ticket_categories (tenant_id, parent_id, name, sort_order) values ($1, $2, $3, 900) returning id", [tenantId, parent, s.slice(0, 100)], db))!.id
        catCache.set(sk, child)
      }
      return { id: child, cat: c, sub: s }
    }

    // ── tickets ──
    const closedAt = new Map<string, Date>()
    for (const a of activity) if (a.action === "closed" && a.created_at) closedAt.set(a.ticket_id, new Date(a.created_at))
    const ticketIds = new Set<string>()
    const counters = new Map<string, number>()
    const typeOf = (t: Row) => (["incident", "service_request", "problem", "change"].includes(t.ticket_type) ? t.ticket_type : "incident")
    const prefix: Record<string, string> = { incident: "INC", service_request: "REQ", problem: "PRB", change: "CHG" }
    for (const t of tickets) {
      const tenantId = tenantOf(t)
      const type = typeOf(t)
      const key = `${tenantId}|${type}`
      let number: string = t.number
      if (!number) {
        const n = (counters.get(key) ?? 1000) + 1
        counters.set(key, n)
        number = `${prefix[type]}${String(n).padStart(7, "0")}`
      }
      if (await q1("select 1 from tickets where id = $1", [t.id], db)) {
        ticketIds.add(t.id)
        bump("tickets_already_present")
        continue
      }
      const status: Status = legacyStatus(t.status)
      const cat = await categoryId(tenantId, t.category, t.sub_category)
      const created = t.created_at ? new Date(t.created_at) : new Date()
      const finished = status === "closed" ? closedAt.get(t.id) ?? (t.updated_at ? new Date(t.updated_at) : created) : null
      const assignee = known(t.assignee)
      const firstResponse = t.assigned_at ?? (status !== "new" ? t.updated_at : null)
      await exec(
        `insert into tickets (id, tenant_id, number, ticket_type, status, subject, description, source, requester_id, requester_name, created_by,
                              contact, location, category_id, category, sub_category, impact, urgency, priority, assignee_id, assigned_at,
                              first_response_at, resolved_at, closed_at, close_comment, hold_reason, hold_started_at, hold_until,
                              sla_response_due, sla_resolution_due, sla_response_breached, sla_resolution_breached, legacy, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, 'migration', $8, $9, $8, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $21, $22,
                 $23, $24, $25, $26, $27, coalesce($28, false), coalesce($29, false), $30, $31::timestamptz, coalesce($32::timestamptz, $31::timestamptz))`,
        [
          t.id, tenantId, number, type, status, String(t.subject ?? "(no subject)").slice(0, 300) || "(no subject)", t.description ?? null,
          known(t.requester_id), t.requester_name ?? null, t.contact ?? null, t.location ?? null, cat.id, cat.cat, cat.sub,
          level(t.impact), level(t.urgency), priority(t.priority), assignee, t.assigned_at ?? null, firstResponse, finished,
          t.closed_comment ?? null, status === "on_hold" ? t.hold_comment ?? "On hold" : null, status === "on_hold" ? t.hold_started_at : null,
          status === "on_hold" ? t.hold_until : null, t.sla_response_at ?? null, t.sla_resolution_at ?? null, t.sla_response_breached,
          t.sla_resolution_breached,
          JSON.stringify({ status: t.status, inventory: t.inventory ?? null, link: t.link ?? null, cc: t.cc ?? null, hold_comment: t.hold_comment ?? null, hold_duration_hours: t.hold_duration_hours ?? null, sla_paused_ms: t.sla_paused_ms ?? null }),
          created, t.updated_at,
        ],
        db
      )
      ticketIds.add(t.id)
      bump("tickets")
      bump(`tickets_${status}`)

      // SLA clocks from the stored deadlines (historical deadlines are kept as they were)
      const policy = await q1<{ id: string }>("select id from sla_policies where tenant_id = $1 and kind = 'sla' and ticket_type = $2 and priority = $3", [tenantId, type, priority(t.priority)], db)
      const clock = async (kind: "response" | "resolution", due: Date | null, breached: boolean, stoppedAt: Date | null) => {
        if (!due) return
        const target = Math.max(1, Math.round((new Date(due).getTime() - created.getTime()) / 60_000))
        const paused = status === "on_hold" && kind === "resolution" && t.hold_started_at
        const st = stoppedAt ? (breached || stoppedAt > new Date(due) ? "breached" : "met") : paused ? "paused" : "active"
        await exec(
          `insert into ticket_sla (tenant_id, ticket_id, kind, policy_id, target_minutes, business_hours, started_at, due_at, status, paused_at, stopped_at, breached, breached_at)
           values ($1, $2, $3, $4, $5, false, $6, $7, $8, $9, $10, $11, case when $11 then $7::timestamptz else null end)`,
          [tenantId, t.id, kind, policy?.id ?? null, target, created, due, st, paused ? t.hold_started_at : null, stoppedAt, st === "breached"],
          db
        )
        bump("sla_clocks")
      }
      await clock("response", t.sla_response_at, !!t.sla_response_breached, firstResponse ? new Date(firstResponse) : finished)
      await clock("resolution", t.sla_resolution_at, !!t.sla_resolution_breached, finished)
    }
    for (const [key, n] of counters) {
      const [tenantId, type] = key.split("|")
      await exec(
        `insert into tenant_counters (tenant_id, record_type, last_value) values ($1, $2, $3)
         on conflict (tenant_id, record_type) do update set last_value = greatest(tenant_counters.last_value, excluded.last_value)`,
        [tenantId, type, n],
        db
      )
    }
    // numbers already present in the old data
    for (const tid of tenantIds) {
      for (const [type, p] of Object.entries(prefix)) {
        await exec(
          `insert into tenant_counters (tenant_id, record_type, last_value)
           select $1, $2, max(substring(number from 4)::bigint) from tickets where tenant_id = $1 and ticket_type = $2 and number ~ ('^' || $3 || '[0-9]+$')
           having count(*) > 0
           on conflict (tenant_id, record_type) do update set last_value = greatest(tenant_counters.last_value, excluded.last_value)`,
          [tid, type, p],
          db
        )
      }
    }

    // ── conversation and history ──
    for (const m of messages) {
      if (!ticketIds.has(m.ticket_id)) continue
      const n = await exec(
        `insert into ticket_comments (id, tenant_id, ticket_id, author_id, author_label, body, is_internal, source, created_at)
         values ($1, $2, $3, $4, $5, $6, false, 'migration', coalesce($7, now())) on conflict do nothing`,
        [m.id, tenantOf(m), m.ticket_id, known(m.sender_id), known(m.sender_id) ? null : m.sender_role === "engineer" ? "Engineer (former account)" : "Requester (former account)", m.message, m.created_at],
        db
      )
      bump(n ? "comments" : "comments_skipped")
    }
    for (const a of activity) {
      if (!ticketIds.has(a.ticket_id)) continue
      const n = await exec(
        "insert into ticket_activity (id, tenant_id, ticket_id, actor_id, action, details, created_at) values ($1, $2, $3, $4, $5, $6, coalesce($7, now())) on conflict do nothing",
        [a.id, tenantOf(a), a.ticket_id, known(a.actor_id), a.action === "hold" ? "status" : a.action, JSON.stringify({ ...(a.details ?? {}), legacy_action: a.action }), a.created_at],
        db
      )
      bump(n ? "activity" : "activity_skipped")
    }
    for (const a of assignments) {
      if (!ticketIds.has(a.ticket_id)) continue
      const n = await exec(
        "insert into ticket_assignments (id, tenant_id, ticket_id, user_id, action, assigned_at, unassigned_at) values ($1, $2, $3, $4, $5, coalesce($6, now()), $7) on conflict do nothing",
        [a.id, tenantOf(a), a.ticket_id, known(a.engineer_id), a.action ?? "assigned", a.assigned_at, a.unassigned_at],
        db
      )
      bump(n ? "assignments" : "assignments_skipped")
    }
    for (const l of links) {
      if (!ticketIds.has(l.from_ticket) || !ticketIds.has(l.to_ticket)) continue
      const n = await exec(
        "insert into ticket_links (id, tenant_id, from_ticket, to_ticket, link_type, created_by, created_at) values ($1, $2, $3, $4, $5, $6, coalesce($7, now())) on conflict do nothing",
        [l.id, tenantOf(l), l.from_ticket, l.to_ticket, l.link_type, known(l.created_by), l.created_at],
        db
      )
      bump(n ? "links" : "links_skipped")
    }
    for (const f of attachments) {
      if (!ticketIds.has(f.ticket_id)) continue
      const n = await exec(
        `insert into files (id, tenant_id, entity_type, entity_id, storage_key, file_name, content_type, size_bytes, legacy_path, created_at)
         values ($1, $2, 'ticket', $3, null, $4, $5, $6, $7, coalesce($8, now())) on conflict do nothing`,
        [f.id, tenantOf(f), f.ticket_id, String(f.file_name ?? "file").slice(0, 200), f.file_type || "application/octet-stream", f.file_size ?? 0, f.file_path ?? null, f.created_at],
        db
      )
      bump(n ? "attachment_records" : "attachment_records_skipped")
    }

    // ── assets → CMDB ──
    const classIds = new Map<string, string>()
    async function classId(tenantId: string, key: string) {
      const k = `${tenantId}|${key}`
      if (!classIds.has(k)) {
        let row = await q1<{ id: string }>("select id from ci_classes where tenant_id = $1 and key = $2", [tenantId, key], db)
        if (!row) {
          const def = DEFAULT_CI_CLASSES.find((c) => c.key === key) ?? DEFAULT_CI_CLASSES.find((c) => c.key === "other")!
          row = await q1<{ id: string }>("insert into ci_classes (tenant_id, key, name, category, attributes) values ($1, $2, $3, $4, $5) returning id", [tenantId, def.key, def.name, def.category, JSON.stringify(def.attributes)], db)
        }
        classIds.set(k, row!.id)
      }
      return classIds.get(k)!
    }
    const detailsByAsset = new Map<string, Record<string, string>>()
    for (const d of details) {
      if (!d.asset_id || !d.key) continue
      const m = detailsByAsset.get(d.asset_id) ?? {}
      m[String(d.key).slice(0, 60)] = d.value ?? ""
      detailsByAsset.set(d.asset_id, m)
    }
    const codes = new Set((await q<{ c: string; t: string }>("select upper(trim(ci_code)) as c, tenant_id as t from configuration_items", [], db)).map((r) => `${r.t}|${r.c}`))
    const ciIds = new Set<string>()
    for (const a of assets) {
      const tenantId = tenantOf(a)
      if (await q1("select 1 from configuration_items where id = $1", [a.id], db)) {
        ciIds.add(a.id)
        bump("cis_already_present")
        continue
      }
      let code = String(a.asset_code ?? "").trim() || `ASSET-${String(a.id).slice(0, 8)}`
      if (codes.has(`${tenantId}|${code.toUpperCase()}`)) {
        let i = 2
        while (codes.has(`${tenantId}|${`${code}-DUP${i}`.toUpperCase()}`)) i++
        code = `${code}-DUP${i}`
        bump("ci_codes_renamed_duplicates")
      }
      codes.add(`${tenantId}|${code.toUpperCase()}`)
      const attrs: Record<string, string> = { ...(detailsByAsset.get(a.id) ?? {}) }
      if (a.asset_type) attrs.legacy_type = a.asset_type
      const cond = typeof a.condition === "string" && CONDITIONS.includes(a.condition.toLowerCase()) ? a.condition.toLowerCase() : null
      if (a.condition && !cond) attrs.legacy_condition = a.condition
      const status = a.status === "spare" ? "in_stock" : a.status === "retired" ? "retired" : "in_use"
      const serial = a.serial_no || attrs.serial_no || null
      delete attrs.serial_no
      await exec(
        `insert into configuration_items (id, tenant_id, class_id, ci_code, name, status, condition, owner_id, organization_id, location, room, department,
                                          manufacturer, model, serial_no, purchase_date, warranty_years, warranty_expiry, attributes, source, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'migration', coalesce($20, now()), coalesce($21, now()))`,
        [
          a.id, tenantId, await classId(tenantId, classKeyForLegacyType(a.asset_type)), code.slice(0, 64),
          ([a.asset_type, a.model].filter(Boolean).join(" ") || code).slice(0, 200), status, cond, known(a.assigned_to), a.organization_id ?? null,
          a.location ?? null, a.room ?? null, a.department ?? null, attrs.vendor ?? null, a.model ?? null, serial, a.purchase_date ?? null,
          a.warranty_years ?? null, a.warranty_expiry ?? null, JSON.stringify(attrs), a.created_at, a.updated_at,
        ],
        db
      )
      ciIds.add(a.id)
      bump("cis")
    }
    for (const a of assets) {
      if (!a.parent_asset_id || !ciIds.has(a.parent_asset_id) || !ciIds.has(a.id) || a.parent_asset_id === a.id) continue
      const n = await exec(
        "insert into ci_relationships (tenant_id, source_id, target_id, rel_type) values ($1, $2, $3, 'contains') on conflict do nothing",
        [tenantOf(a), a.parent_asset_id, a.id],
        db
      )
      bump(n ? "ci_relationships" : "ci_relationships_skipped")
    }
    const openByCi = new Set<string>()
    for (const r of assetAssign) {
      if (!ciIds.has(r.asset_id) || !known(r.user_id)) {
        bump("ci_assignments_skipped")
        continue
      }
      let returned = r.returned_at
      if (!returned && openByCi.has(r.asset_id)) returned = r.assigned_at // keep only the latest one open
      if (!returned) openByCi.add(r.asset_id)
      const n = await exec(
        `insert into ci_assignments (id, tenant_id, ci_id, user_id, assigned_by, assigned_at, returned_at, note)
         values ($1, $2, $3, $4, $5, coalesce($6, now()), $7, $8) on conflict do nothing`,
        [r.id, tenantOf(r), r.asset_id, r.user_id, known(r.assigned_by), r.assigned_at, returned, r.note ?? null],
        db
      ).catch(async () => {
        // a later open assignment already exists for this CI: store this one as returned
        return exec(
          `insert into ci_assignments (id, tenant_id, ci_id, user_id, assigned_by, assigned_at, returned_at, note)
           values ($1, $2, $3, $4, $5, coalesce($6, now()), coalesce($6, now()), $7) on conflict do nothing`,
          [r.id, tenantOf(r), r.asset_id, r.user_id, known(r.assigned_by), r.assigned_at, r.note ?? null],
          db
        )
      })
      bump(n ? "ci_assignments" : "ci_assignments_skipped")
    }
    for (const at of assetTickets) {
      if (!ciIds.has(at.asset_id) || !ticketIds.has(at.ticket_id)) continue
      const n = await exec("insert into ticket_cis (ticket_id, ci_id, role, created_at) values ($1, $2, 'affected', coalesce($3, now())) on conflict do nothing", [at.ticket_id, at.asset_id, at.linked_at], db)
      bump(n ? "ticket_ci_links" : "ticket_ci_links_skipped")
    }

    for (const tid of tenantIds) {
      await audit({ tenantId: tid, actor: null, action: "system.legacy_import", entityType: "tenant", entityId: tid, summary: DRY ? "Dry run" : "Imported data from the previous helpdesk", data: counts }, db)
    }
    if (DRY) throw new DryRun()
  }).catch((err) => {
    if (!(err instanceof DryRun)) throw err
  })

  console.log(DRY ? "DRY RUN (nothing was saved). Would import:" : "Imported:")
  for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k.padEnd(32)} ${v}`)
  console.log("Not imported by design: notifications (transient), AskMira connector tables, HR fields (date of birth, addresses).")
  console.log("Attachment files: only their records were imported; see docs/MIGRATION.md to fetch the files from Supabase Storage.")
}

class DryRun extends Error {}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => pool().end())
