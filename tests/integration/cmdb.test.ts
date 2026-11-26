/**
 * CMDB service tests against a real PostgreSQL database
 * (TEST_DATABASE_URL, default: the dev compose database `itsm_test`).
 * Each run creates its own tenants, so it can run repeatedly.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest"
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://itsm:itsm_dev_password@localhost:5544/itsm_test"

const { pool, q1, q, exec } = await import("@/lib/db")
const { migrate } = await import("@/lib/db/migrate")
const { createTenant } = await import("@/lib/tenants")
const { actorForUser } = await import("@/lib/auth/session")
const svc = await import("@/lib/cmdb/service")
const queries = await import("@/lib/cmdb/queries")
const imp = await import("@/lib/cmdb/import")

let reachable = true
try {
  await pool().query("select 1")
} catch {
  reachable = false
}

type A = NonNullable<Awaited<ReturnType<typeof actorForUser>>>
let tenantId = ""
let otherTenantId = ""
const ids: Record<string, string> = {}
const actors: Record<string, A> = {}
const classIds: Record<string, string> = {}

async function user(key: string, role: string, tenant = tenantId) {
  const row = await q1<{ id: string }>("insert into users (tenant_id, email, full_name, role) values ($1, $2, $3, $4) returning id", [
    tenant,
    `${key}.${Date.now()}@cmdb.test`,
    key,
    role,
  ])
  ids[key] = row!.id
  actors[key] = (await actorForUser(row!.id, "test"))!
}

async function ci(code: string, cls = "server", extra: Record<string, unknown> = {}) {
  return svc.createCi(actors.admin, { classId: classIds[cls], ciCode: code, name: `${code} name`, ...extra })
}

describe.skipIf(!reachable)("CMDB service (integration)", () => {
  beforeAll(async () => {
    await migrate()
    tenantId = await createTenant(`CMDB Test ${Date.now()}`, { timezone: "UTC" })
    otherTenantId = await createTenant(`CMDB Other ${Date.now()}`, { timezone: "UTC" })
    await user("admin", "admin")
    await user("asha", "engineer")
    await user("meera", "user")
    await user("outsider", "admin", otherTenantId)
    for (const r of await q<{ id: string; key: string }>("select id, key from ci_classes where tenant_id = $1", [tenantId])) classIds[r.key] = r.id
  })
  afterAll(async () => {
    await pool().end()
  })

  it("creates items, refuses duplicate codes (trimmed, any case) and validates attributes", async () => {
    const a = await ci("SRV-APP1", "server", { attributes: { cpu: "Xeon", rack: "R1" }, purchaseDate: "2024-01-10", warrantyYears: 3 })
    expect(a.warranty_expiry).toBe("2027-01-10")
    expect(a.attributes).toEqual({ cpu: "Xeon", rack: "R1" })
    await expect(ci("  srv-app1 ")).rejects.toThrow(/already used/)
    const h = await q<{ action: string; changes: Record<string, unknown> }>("select action, changes from ci_history where ci_id = $1", [a.id])
    expect(h[0].action).toBe("created")
    expect(h[0].changes).toMatchObject({ ci_code: { from: null, to: "SRV-APP1" }, "attributes.cpu": { from: null, to: "Xeon" } })

    // required attributes are enforced on the server
    const cls = await svc.createClass(actors.admin, { key: `ups_${Date.now() % 100000}`, name: "UPS", category: "hardware", attributes: [{ key: "va", label: "Capacity (VA)", type: "number", required: true }] })
    await expect(svc.createCi(actors.admin, { classId: cls.id, ciCode: "UPS-1", name: "UPS" })).rejects.toThrow(/Capacity \(VA\) is required/)
    await expect(svc.createCi(actors.admin, { classId: cls.id, ciCode: "UPS-1", name: "UPS", attributes: { va: "lots" } })).rejects.toThrow(/not a number/)
    const ups = await svc.createCi(actors.admin, { classId: cls.id, ciCode: "UPS-1", name: "UPS", attributes: { va: "1500" } })
    expect(ups.attributes).toEqual({ va: 1500 })
    // a class in use cannot be deleted
    await expect(svc.deleteClass(actors.admin, cls.id)).rejects.toThrow(/Deactivate/)
  })

  it("parses the CI and class forms the way the server actions do", async () => {
    const { formObject } = await import("@/lib/validate")
    const { ciInputFromForm, attributeSchemaFromForm } = await import("@/lib/cmdb/forms")
    const fd = new FormData()
    for (const [k, v] of Object.entries({ classId: classIds.monitor, ciCode: " MON-1 ", name: "Monitor", status: "in_use", cost: "1,299.00", purchaseDate: "2025-06-01", warrantyYears: "2", "attr.size": "27", ownerId: "", condition: "" })) fd.set(k, v)
    const created = await svc.createCi(actors.asha, ciInputFromForm(formObject(fd)))
    expect(created).toMatchObject({ ci_code: "MON-1", cost: 1299, warranty_expiry: "2027-06-01", attributes: { size: 27 }, owner_id: null, condition: null })
    fd.set("cost", "abc")
    expect(() => ciInputFromForm(formObject(fd))).toThrow(/Cost/)
    const schema = new FormData()
    schema.set("a.0.key", "va")
    schema.set("a.0.type", "number")
    schema.set("a.0.required", "on")
    expect(attributeSchemaFromForm(formObject(schema))).toEqual([{ key: "va", label: "Va", type: "number", required: true }])
    schema.set("a.1.key", "Bad Key")
    expect(() => attributeSchemaFromForm(formObject(schema))).toThrow(/Attribute 2/)
  })

  it("records a field-level diff on update, with owner shown by email", async () => {
    const c = await ci("LAP-100", "laptop", { attributes: { ram: "8 GB" } })
    await svc.updateCi(actors.asha, c.id, { classId: classIds.laptop, ciCode: "LAP-100", name: "Asha's laptop", ownerId: ids.asha, attributes: { ram: "16 GB" }, room: "" })
    const h = await q1<{ changes: Record<string, { from: unknown; to: unknown }> }>("select changes from ci_history where ci_id = $1 and action = 'updated'", [c.id])
    expect(h!.changes.name).toEqual({ from: "LAP-100 name", to: "Asha's laptop" })
    expect(h!.changes["attributes.ram"]).toEqual({ from: "8 GB", to: "16 GB" })
    expect((h!.changes.owner.to as string).startsWith("asha.")).toBe(true)
    expect(Object.keys(h!.changes)).not.toContain("room")
    // owner and the open assignment stay in step
    const open = await q<{ user_id: string }>("select user_id from ci_assignments where ci_id = $1 and returned_at is null", [c.id])
    expect(open.map((o) => o.user_id)).toEqual([ids.asha])
    // a no-op update writes nothing
    const before = await q1<{ n: number }>("select count(*) as n from ci_history where ci_id = $1", [c.id])
    await svc.updateCi(actors.asha, c.id, { name: "Asha's laptop" })
    expect((await q1<{ n: number }>("select count(*) as n from ci_history where ci_id = $1", [c.id]))!.n).toBe(before!.n)
  })

  it("assigns and returns with only one open assignment", async () => {
    const c = await ci("LAP-200", "laptop", { status: "in_stock" })
    await svc.assignCi(actors.admin, c.id, ids.meera, "With charger")
    let row = await q1<{ owner_id: string; status: string }>("select owner_id, status from configuration_items where id = $1", [c.id])
    expect(row).toEqual({ owner_id: ids.meera, status: "in_use" })
    await expect(svc.assignCi(actors.admin, c.id, ids.meera)).rejects.toThrow(/already assigned/)
    await svc.assignCi(actors.admin, c.id, ids.asha) // transfer closes the previous one
    const open = await q<{ user_id: string }>("select user_id from ci_assignments where ci_id = $1 and returned_at is null", [c.id])
    expect(open.map((o) => o.user_id)).toEqual([ids.asha])
    await svc.returnCi(actors.admin, c.id, "Returned to IT")
    row = await q1<{ owner_id: string; status: string }>("select owner_id, status from configuration_items where id = $1", [c.id])
    expect(row).toEqual({ owner_id: null, status: "in_stock" })
    await expect(svc.returnCi(actors.admin, c.id)).rejects.toThrow(/not assigned/)
    const hist = await q<{ action: string }>("select action from ci_history where ci_id = $1 order by created_at", [c.id])
    expect(hist.map((h) => h.action)).toEqual(["created", "assigned", "assigned", "returned"])
    // retired items cannot be assigned
    await svc.retireCi(actors.admin, c.id)
    await expect(svc.assignCi(actors.admin, c.id, ids.meera)).rejects.toThrow(/Retired/)
  })

  it("analyses impact transitively with depth and cycle protection", async () => {
    // APP-A runs on VM-1, VM-1 hosted on HOST-1, RACK-1 contains HOST-1, APP-B depends on APP-A,
    // and a cycle: HOST-1 depends on APP-B
    const [appA, vm, host, rack, appB] = [await ci("APP-A", "application"), await ci("VM-1", "virtual_machine"), await ci("HOST-1"), await ci("RACK-1", "other"), await ci("APP-B", "application")]
    await svc.addRelationship(actors.asha, appA.id, "vm-1", "runs_on")
    await svc.addRelationship(actors.asha, vm.id, "HOST-1", "hosted_on")
    await svc.addRelationship(actors.asha, rack.id, "HOST-1", "contains")
    await svc.addRelationship(actors.asha, appB.id, "APP-A", "depends_on")
    await svc.addRelationship(actors.asha, host.id, "APP-B", "depends_on")
    await expect(svc.addRelationship(actors.asha, appA.id, "VM-1", "runs_on")).rejects.toThrow(/already exists/)
    await expect(svc.addRelationship(actors.asha, appA.id, "APP-A", "uses")).rejects.toThrow(/itself/)
    await expect(svc.addRelationship(actors.asha, appA.id, "NOPE", "uses")).rejects.toThrow(/No configuration item/)

    const impact = await queries.impactOf(actors.asha, host.id)
    expect(impact.map((r) => [r.ci_code, r.depth])).toEqual([["VM-1", 1], ["APP-A", 2], ["APP-B", 3]])
    expect(impact.find((r) => r.ci_code === "APP-B")!.path).toBe("HOST-1 → VM-1 → APP-A → APP-B")
    // the rack failing takes down the host (contains is reversed), and everything above it
    expect((await queries.impactOf(actors.asha, rack.id)).map((r) => r.ci_code)).toEqual(["HOST-1", "VM-1", "APP-A", "APP-B"])
    const deps = await queries.dependenciesOf(actors.asha, appA.id)
    // APP-B → APP-A closes a cycle, so it stops there
    expect(deps.map((r) => [r.ci_code, r.depth])).toEqual([["VM-1", 1], ["HOST-1", 2], ["APP-B", 3], ["RACK-1", 3]])

    const d = await queries.getCiDetail(actors.asha, vm.id)
    expect(d.outgoing.map((r) => r.other_code)).toEqual(["HOST-1"])
    expect(d.incoming.map((r) => r.other_code)).toEqual(["APP-A"])
    await svc.removeRelationship(actors.asha, vm.id, d.outgoing[0].id)
    expect((await queries.impactOf(actors.asha, host.id)).length).toBe(0)
    const removed = await q1<{ changes: Record<string, { from: unknown }> }>("select changes from ci_history where ci_id = $1 and action = 'relationship_removed'", [host.id])
    expect(removed!.changes.relationship.from).toBe("Hosts VM-1")
  })

  it("deletes with audit, keeps the history row, and enforces permissions and tenants", async () => {
    const c = await ci("DEL-1")
    await expect(svc.deleteCi(actors.asha, c.id)).rejects.toThrow(/cannot delete/)
    await expect(queries.getCiDetail(actors.meera, c.id)).rejects.toThrow(/cannot view/)
    await expect(queries.getCiDetail(actors.outsider, c.id)).rejects.toThrow(/not found/)
    await expect(svc.updateCi(actors.outsider, c.id, { name: "x" })).rejects.toThrow(/not found/)
    await svc.deleteCi(actors.admin, c.id)
    expect(await q1("select 1 from configuration_items where id = $1", [c.id])).toBeNull()
    const h = await q1<{ changes: Record<string, { from: unknown; to: unknown }> }>("select changes from ci_history where ci_id = $1 and action = 'deleted'", [c.id])
    expect(h!.changes.ci_code).toEqual({ from: "DEL-1", to: null })
    const a = await q1<{ summary: string }>("select summary from audit_log where tenant_id = $1 and action = 'cmdb.ci_deleted' and entity_id = $2", [tenantId, c.id])
    expect(a!.summary).toMatch(/DEL-1/)
  })

  it("imports a CSV: preview, upsert by code in one transaction, summary and audit", async () => {
    await ci("IMP-EXIST", "desktop", { attributes: { cpu: "i3" } })
    const email = (await q1<{ email: string }>("select email from users where id = $1", [ids.meera]))!.email
    const csv =
      "﻿asset_code;Name;asset_type;status;assigned_to_email;serial;vendor;purchase_date;warranty_years;cpu;ram\r\n" +
      `IMP-1;"Laptop; one";Notebook;spare;${email};SN-1;Dell;15/03/2024;3;i7;16 GB\r\n` +
      "imp-exist;;;in use;;;;;;i5;\r\n" +
      "IMP-2;Broken row;Laptop;borrowed;;;;31/02/2024;;;\r\n" +
      "IMP-1;Duplicate;Laptop;;;;;;;;\r\n" +
      "\r\n" +
      "IMP-3;Unknown owner;Server;;nobody@nowhere.test;;;;;;\r\n"
    const fileId = await imp.stageImport(actors.asha, new File([csv], "assets.exe", { type: "application/x-msdownload" }))
    const stored = await q1<{ file_name: string }>("select file_name from files where id = $1", [fileId])
    expect(stored!.file_name).toBe("assets.csv")
    // another user cannot see someone else's upload
    await expect(imp.previewImport(actors.admin, fileId)).rejects.toThrow(/not found/)

    const preview = await imp.previewImport(actors.asha, fileId)
    expect(preview.plan!.delimiter).toBe(";")
    expect(preview.plan!.counts).toMatchObject({ rows: 5, create: 2, update: 1, error: 2 })
    expect(preview.plan!.rows.map((r) => r.action)).toEqual(["create", "update", "error", "error", "create"])

    const s = await imp.commitImport(actors.asha, fileId)
    expect(s).toMatchObject({ created: 2, updated: 1, unchanged: 0, skipped: 2 })
    expect([...new Set(s.errors.map((e) => e.line))]).toEqual([4, 5])
    expect(s.errors.filter((e) => e.line === 4).map((e) => e.message)).toEqual([
      'Status: unknown status "borrowed"',
      'Purchase date: "31/02/2024" is not a date (use YYYY-MM-DD or DD/MM/YYYY)',
    ])
    expect(s.warnings.some((w) => /nobody@nowhere/.test(w.message))).toBe(true)
    const one = await q1<{ name: string; status: string; owner_id: string; warranty_expiry: string; attributes: Record<string, unknown>; class_id: string; source: string }>(
      "select name, status, owner_id, warranty_expiry, attributes, class_id, source from configuration_items where tenant_id = $1 and ci_code = 'IMP-1'",
      [tenantId]
    )
    expect(one).toMatchObject({ name: "Laptop; one", status: "in_stock", owner_id: ids.meera, warranty_expiry: "2027-03-15", class_id: classIds.laptop, source: "import" })
    expect(one!.attributes).toEqual({ cpu: "i7", ram: "16 GB" })
    const ex = await q1<{ status: string; attributes: Record<string, unknown>; name: string }>("select status, attributes, name from configuration_items where tenant_id = $1 and ci_code = 'IMP-EXIST'", [tenantId])
    expect(ex).toEqual({ status: "in_use", attributes: { cpu: "i5" }, name: "IMP-EXIST name" })
    const hist = await q<{ action: string }>("select h.action from ci_history h join configuration_items c on c.id = h.ci_id where c.tenant_id = $1 and c.ci_code like 'IMP-%' and h.action like 'import_%'", [tenantId])
    expect(hist.length).toBe(3)
    const a = await q1<{ data: { created: number } }>("select data from audit_log where tenant_id = $1 and action = 'cmdb.import' and entity_id = $2", [tenantId, fileId])
    expect(a!.data.created).toBe(2)
    await expect(imp.commitImport(actors.asha, fileId)).rejects.toThrow(/already been imported/)
    expect((await imp.previewImport(actors.asha, fileId)).committed).not.toBeNull()

    await expect(imp.stageImport(actors.asha, new File(["name\nx\n"], "x.csv"))).rejects.toThrow(/ci_code column/)
    await expect(imp.stageImport(actors.meera, new File(["ci_code\nx\n"], "x.csv"))).rejects.toThrow(/cannot import/)
  })

  it("exports with the list filters", async () => {
    const all = await queries.exportCis(actors.asha, { q: "IMP" })
    expect(all.header.slice(0, 3)).toEqual(["ci_code", "name", "class"])
    expect(all.header).toContain("cpu")
    expect(all.rows.length).toBe(3)
    const list = await queries.listCis(actors.asha, { q: "imp-1" })
    expect(list.rows.map((r) => r.ci_code)).toEqual(["IMP-1"])
    const stock = await queries.listCis(actors.asha, { status: "in_stock", class: "laptop" })
    expect(stock.rows.map((r) => r.ci_code)).toContain("IMP-1")
  })

  it("finds or creates the CI for an agent-reported device", async () => {
    const device = { hostname: "ws-0042", os_family: "windows", os_name: "Windows 11 Pro", manufacturer: "Dell Inc.", model: "Latitude 7440", serial_no: "ABC1234", cpu: "Intel i7-1365U", ram_mb: 16_384, mac_addresses: ["aa-bb-cc-dd-ee-01"], ip_addresses: ["10.1.2.3"] }
    const id1 = await svc.findOrCreateCiForDevice(pool(), tenantId, device)
    const created = await q1<{ ci_code: string; class_id: string; source: string; last_seen_at: Date; attributes: Record<string, unknown> }>("select ci_code, class_id, source, last_seen_at, attributes from configuration_items where id = $1", [id1])
    expect(created).toMatchObject({ ci_code: "WS-0042", class_id: classIds.laptop, source: "agent" })
    expect(created!.attributes).toMatchObject({ cpu: "Intel i7-1365U", ram: "16 GB", os_name: "Windows 11 Pro" })

    // same serial, new host name: same CI
    const id2 = await svc.findOrCreateCiForDevice(pool(), tenantId, { ...device, hostname: "ws-renamed", ram_mb: 32_768 })
    expect(id2).toBe(id1)
    expect((await q1<{ attributes: { ram: string } }>("select attributes from configuration_items where id = $1", [id1]))!.attributes.ram).toBe("32 GB")
    // an unchanged report writes no history
    const n = (await q1<{ n: number }>("select count(*) as n from ci_history where ci_id = $1", [id1]))!.n
    await svc.findOrCreateCiForDevice(pool(), tenantId, { ...device, hostname: "ws-renamed", ram_mb: 32_768 })
    expect((await q1<{ n: number }>("select count(*) as n from ci_history where ci_id = $1", [id1]))!.n).toBe(n)

    // no usable serial: matched by host name to a manually created CI, which becomes agent-sourced
    const manual = await ci("SRV-DB01", "server")
    const id3 = await svc.findOrCreateCiForDevice(pool(), tenantId, { hostname: "srv-db01", os_name: "Windows Server 2022", serial_no: "To be filled by O.E.M." })
    expect(id3).toBe(manual.id)
    expect((await q1<{ source: string }>("select source from configuration_items where id = $1", [id3]))!.source).toBe("agent")
    // a server OS gets the server class; it joins the caller's transaction when given a client
    const client = await pool().connect()
    try {
      await client.query("begin")
      const id4 = await svc.findOrCreateCiForDevice(client, tenantId, { hostname: "linux-01", os_name: "Ubuntu Server 24.04" })
      await client.query("rollback")
      expect(await q1("select 1 from configuration_items where id = $1", [id4])).toBeNull()
    } finally {
      client.release()
    }
    // tenants never see each other's devices
    const id5 = await svc.findOrCreateCiForDevice(pool(), otherTenantId, device)
    expect(id5).not.toBe(id1)
    await exec("select 1")
  })
})
