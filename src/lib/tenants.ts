/**
 * Tenants: creation with default configuration (categories, priority matrix,
 * SLA policies, calendar, CI classes, a service desk and a CAB group), and the
 * first-start bootstrap. Nothing customer-specific is hard-coded here.
 */
import { q1, exec, tx, type Db } from "@/lib/db"
import { DEFAULT_CATEGORIES, DEFAULT_MATRIX, DEFAULT_SLA, PRIORITIES } from "@/lib/itsm/vocab"
import { DEFAULT_CI_CLASSES } from "@/lib/cmdb/classes"
import { hashPassword } from "@/lib/auth/password"
import { config } from "@/lib/config"
import { log } from "@/lib/log"
import { audit } from "@/lib/audit"

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  return s.length >= 2 ? s : `tenant-${Date.now().toString(36)}`
}

export type SeedOptions = {
  timezone?: string
  /** SLA defaults: "standard" (DEFAULT_SLA) or "legacy" (15 min / 6 h, around the clock) */
  slaProfile?: "standard" | "legacy"
}

/** Fills in whatever default configuration a tenant is missing. Re-runnable. */
export async function seedTenantDefaults(db: Db, tenantId: string, opts: SeedOptions = {}): Promise<void> {
  await exec(
    "insert into tenant_settings (tenant_id, timezone) values ($1, $2) on conflict (tenant_id) do nothing",
    [tenantId, opts.timezone ?? "UTC"],
    db
  )

  const hasCats = await q1("select 1 from ticket_categories where tenant_id = $1 limit 1", [tenantId], db)
  if (!hasCats) {
    let i = 0
    for (const c of DEFAULT_CATEGORIES) {
      i++
      const parent = await q1<{ id: string }>(
        "insert into ticket_categories (tenant_id, name, sort_order, ticket_types) values ($1, $2, $3, $4) returning id",
        [tenantId, c.name, i, c.types],
        db
      )
      let j = 0
      for (const sub of c.subs) {
        j++
        await exec("insert into ticket_categories (tenant_id, parent_id, name, sort_order) values ($1, $2, $3, $4)", [tenantId, parent!.id, sub, j], db)
      }
    }
  }

  for (const m of DEFAULT_MATRIX) {
    await exec(
      "insert into priority_matrix (tenant_id, impact, urgency, priority) values ($1, $2, $3, $4) on conflict do nothing",
      [tenantId, m.impact, m.urgency, m.priority],
      db
    )
  }

  const hasSla = await q1("select 1 from sla_policies where tenant_id = $1 limit 1", [tenantId], db)
  if (!hasSla) {
    for (const type of ["incident", "service_request"]) {
      for (const p of PRIORITIES) {
        const d = opts.slaProfile === "legacy" ? { response: 15, resolution: 360, businessHours: false } : DEFAULT_SLA[p]
        await exec(
          `insert into sla_policies (tenant_id, kind, ticket_type, priority, response_minutes, resolution_minutes, business_hours)
           values ($1, 'sla', $2, $3, $4, $5, $6)`,
          [tenantId, type, p, d.response, d.resolution, d.businessHours],
          db
        )
      }
    }
  }

  for (const c of DEFAULT_CI_CLASSES) {
    await exec(
      "insert into ci_classes (tenant_id, key, name, category, attributes) values ($1, $2, $3, $4, $5) on conflict (tenant_id, key) do nothing",
      [tenantId, c.key, c.name, c.category, JSON.stringify(c.attributes)],
      db
    )
  }

  await exec(
    `insert into groups (tenant_id, name, description, kind) values
       ($1, 'Service Desk', 'First-line support', 'support'),
       ($1, 'Change Advisory Board', 'Approves normal and emergency changes', 'cab')
     on conflict do nothing`,
    [tenantId],
    db
  )
  await exec(
    "insert into kb_categories (tenant_id, name, sort_order) values ($1, 'General', 1), ($1, 'How-to', 2), ($1, 'Known errors', 3) on conflict do nothing",
    [tenantId],
    db
  )
  await exec(
    "insert into device_groups (tenant_id, name, description, ring) values ($1, 'Pilot', 'Receives patches first', 0), ($1, 'Production', 'Everyone else', 1) on conflict do nothing",
    [tenantId],
    db
  )
}

export async function createTenant(name: string, opts: SeedOptions & { slug?: string; id?: string } = {}, db?: Db): Promise<string> {
  const runner = async (c: Db) => {
    const row = await q1<{ id: string }>(
      "insert into tenants (id, name, slug) values (coalesce($1, gen_random_uuid()), $2, $3) returning id",
      [opts.id ?? null, name.trim(), opts.slug ?? slugify(name)],
      c
    )
    await seedTenantDefaults(c, row!.id, opts)
    return row!.id
  }
  return db ? runner(db) : tx(runner)
}

/**
 * First start: when there are no tenants yet, create one and a super admin
 * from BOOTSTRAP_* settings. Without a password, nothing is created and the
 * log explains how to finish setup.
 */
export async function bootstrapIfEmpty(): Promise<void> {
  const any = await q1("select 1 from tenants limit 1")
  if (any) return
  const b = config.bootstrap()
  if (!b.adminEmail || !b.adminPassword) {
    log.warn("bootstrap.waiting", { hint: "Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD, or run `npm run db:seed`" })
    return
  }
  await tx(async (c) => {
    const tenantId = await createTenant(b.tenantName, {}, c)
    const user = await q1<{ id: string }>(
      `insert into users (tenant_id, email, full_name, role, password_hash, password_changed_at, must_change_password)
       values ($1, lower($2), 'Administrator', 'superadmin', $3, now(), true) returning id`,
      [tenantId, b.adminEmail, await hashPassword(b.adminPassword!)],
      c
    )
    await exec("insert into group_members (group_id, user_id) select id, $2 from groups where tenant_id = $1", [tenantId, user!.id], c)
    await audit({ tenantId, actor: null, action: "system.bootstrap", entityType: "tenant", entityId: tenantId, summary: "First tenant and super admin created" }, c)
  })
  log.info("bootstrap.done", { tenant: b.tenantName })
}
