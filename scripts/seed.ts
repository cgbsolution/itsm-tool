/**
 * Creates a tenant (if needed) and a super admin.
 *   npm run db:seed -- --email admin@example.com [--name "Admin"] [--tenant "Company"] [--password ...] [--demo]
 * Without --password a random one is generated and printed once; it must be
 * changed at first sign-in. --demo adds sample people, groups and tickets
 * (for test databases only).
 */
import "./_env"
import crypto from "node:crypto"
import { pool, q1, tx, exec } from "@/lib/db"
import { migrate } from "@/lib/db/migrate"
import { createTenant } from "@/lib/tenants"
import { hashPassword } from "@/lib/auth/password"
import { actorForUser } from "@/lib/auth/session"
import { createTicket } from "@/lib/itsm/tickets"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  await migrate()
  const email = (arg("email") ?? "").toLowerCase()
  if (!email.includes("@")) throw new Error("Pass --email for the super admin")
  const tenantName = arg("tenant")
  const generated = !arg("password")
  const password = arg("password") ?? crypto.randomBytes(12).toString("base64url")

  const tenantId = await tx(async (db) => {
    let t = tenantName ? await q1<{ id: string }>("select id from tenants where lower(name) = lower($1)", [tenantName], db) : await q1<{ id: string }>("select id from tenants order by created_at limit 1", [], db)
    if (!t) t = { id: await createTenant(tenantName ?? "Default", { timezone: arg("timezone") ?? "UTC" }, db) }
    const existing = await q1("select 1 from users where lower(email) = $1", [email], db)
    if (existing) throw new Error(`${email} already exists`)
    const u = await q1<{ id: string }>(
      `insert into users (tenant_id, email, full_name, role, password_hash, password_changed_at, must_change_password)
       values ($1, $2, $3, 'superadmin', $4, now(), $5) returning id`,
      [t.id, email, arg("name") ?? "Administrator", await hashPassword(password), generated],
      db
    )
    await exec("insert into group_members (group_id, user_id) select id, $2 from groups where tenant_id = $1 on conflict do nothing", [t.id, u!.id], db)
    return t.id
  })
  console.log(`Super admin ${email} created in tenant ${tenantId}.`)
  if (generated) console.log(`Temporary password (change it at first sign-in): ${password}`)

  if (process.argv.includes("--demo")) await demo(tenantId, email)
}

async function demo(tenantId: string, adminEmail: string) {
  const pw = await hashPassword("Demo-password-1")
  const people = [
    ["asha.engineer@example.com", "Asha Engineer", "engineer"],
    ["ravi.engineer@example.com", "Ravi Engineer", "engineer"],
    ["meera.user@example.com", "Meera Requester", "user"],
    ["john.user@example.com", "John Requester", "user"],
  ]
  for (const [e, n, r] of people) {
    await exec("insert into users (tenant_id, email, full_name, role, password_hash) values ($1, $2, $3, $4, $5) on conflict do nothing", [tenantId, e, n, r, pw])
  }
  await exec(
    `insert into group_members (group_id, user_id)
     select g.id, u.id from groups g join users u on u.tenant_id = g.tenant_id
      where g.tenant_id = $1 and g.name = 'Service Desk' and u.role = 'engineer' on conflict do nothing`,
    [tenantId]
  )
  const admin = await q1<{ id: string }>("select id from users where email = $1", [adminEmail])
  const actor = (await actorForUser(admin!.id, "seed"))!
  const meera = await q1<{ id: string }>("select id from users where email = 'meera.user@example.com'")
  const cat = await q1<{ id: string }>("select id from ticket_categories where tenant_id = $1 and name = 'VPN Issues'", [tenantId])
  await createTicket(actor, { type: "incident", subject: "VPN disconnects every few minutes", description: "Since this morning the VPN drops every 5 minutes.", requesterId: meera!.id, categoryId: cat?.id, impact: "medium", urgency: "high" })
  await createTicket(actor, { type: "service_request", subject: "New laptop for joiner", requesterId: meera!.id, impact: "low", urgency: "medium" })
  await createTicket(actor, { type: "problem", subject: "Recurring VPN drops for remote staff", impact: "high", urgency: "medium" })
  console.log("Demo people (password Demo-password-1) and tickets added.")
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => pool().end())
