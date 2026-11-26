/**
 * CSV import of configuration items: stage (save the uploaded file), preview
 * (parse + validate from the stored file) and commit (upsert by CI code in one
 * transaction). The browser never sends parsed data: both preview and commit
 * re-read the stored file.
 */
import { q, q1, exec, tx, isUuid, pool, type Db } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { AppError, forbidden, notFound } from "@/lib/errors"
import { audit } from "@/lib/audit"
import { readFileBytes, saveBuffer } from "@/lib/files/storage"
import { sanitizeFileName } from "@/lib/files/sniff"
import { readSchema } from "@/lib/cmdb/attributes"
import { CsvError, decodeCsvBuffer, parseCsv, type CsvDelimiter } from "@/lib/cmdb/csv"
import { hasChanges } from "@/lib/cmdb/diff"
import {
  IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, hasCodeColumn, mapColumns, normalizeRow, resolveClass, rowAttributes,
  type ColumnMap, type ImportClass, type RowValues,
} from "@/lib/cmdb/mapping"
import { CI_COLUMNS, ciChanges, syncAssignment, type CiRow } from "@/lib/cmdb/service"

const IMPORT_ACTION = "cmdb.import"

function requireEdit(actor: Actor) {
  if (!actor.permissions.has("cmdb.edit")) throw forbidden("You cannot import configuration items")
}

type Parsed = { delimiter: CsvDelimiter; headers: string[]; records: string[][]; lines: number[]; columns: ColumnMap[] }

/** Decodes and parses an upload, with the size, row and column checks. Throws AppError. */
export function parseImportBuffer(buf: Uint8Array): Parsed {
  if (buf.length === 0) throw new AppError("The file is empty")
  if (buf.length > IMPORT_MAX_BYTES) throw new AppError(`The file is larger than ${IMPORT_MAX_BYTES / 1024 / 1024} MB`)
  let result
  try {
    result = parseCsv(decodeCsvBuffer(buf))
  } catch (e) {
    if (e instanceof CsvError) throw new AppError(e.message)
    throw e
  }
  const [headers, ...records] = result.rows
  if (!headers || headers.every((h) => !h.trim())) throw new AppError("The file has no header row")
  if (records.length === 0) throw new AppError("The file has a header row but no data")
  if (records.length > IMPORT_MAX_ROWS) throw new AppError(`The file has ${records.length.toLocaleString("en")} rows; import at most ${IMPORT_MAX_ROWS.toLocaleString("en")} at a time`)
  const columns = mapColumns(headers)
  if (!hasCodeColumn(columns)) throw new AppError("The file needs a ci_code column (or asset_code / code)")
  return { delimiter: result.delimiter, headers, records, lines: result.lines.slice(1), columns }
}

/** Saves an uploaded CSV after checking that it parses. Returns the file id. */
export async function stageImport(actor: Actor, file: File): Promise<string> {
  requireEdit(actor)
  if (file.size === 0) throw new AppError("Choose a CSV file first")
  if (file.size > IMPORT_MAX_BYTES) throw new AppError(`The file is larger than ${IMPORT_MAX_BYTES / 1024 / 1024} MB`)
  const buf = Buffer.from(await file.arrayBuffer())
  parseImportBuffer(buf)
  // The stored name always ends in .csv: the content was checked above, the client's name is not trusted.
  const base = sanitizeFileName(file.name || "import").replace(/\.[A-Za-z0-9]{1,8}$/, "").slice(0, 150) || "import"
  const saved = await saveBuffer(buf, `${base}.csv`, { tenantId: actor.tenantId, entityType: "import", entityId: null, uploadedBy: actor.id })
  return saved.id
}

type ImportFile = { id: string; file_name: string; storage_key: string | null; size_bytes: number; created_at: Date; uploaded_by: string | null }

async function loadFile(actor: Actor, fileId: string, db: Db, lock = false): Promise<ImportFile> {
  if (!isUuid(fileId)) throw notFound("Import file not found")
  const f = await q1<ImportFile>(
    `select id, file_name, storage_key, size_bytes, created_at, uploaded_by from files
      where id = $1 and tenant_id = $2 and entity_type = 'import' ${lock ? "for update" : ""}`,
    [fileId, actor.tenantId],
    db
  )
  // Only the person who uploaded the file can preview or commit it
  if (!f || f.uploaded_by !== actor.id || !f.storage_key) throw notFound("Import file not found")
  return f
}

export type PlannedRow = {
  line: number
  action: "create" | "update" | "error"
  code: string
  values: RowValues | null
  classId: string | null
  className: string | null
  ownerId: string | null
  attributes: Record<string, unknown> | null
  rawAttributes: Record<string, string>
  existing: CiRow | null
  errors: string[]
  warnings: string[]
}

export type ImportPlan = {
  file: ImportFile
  delimiter: CsvDelimiter
  columns: ColumnMap[]
  rows: PlannedRow[]
  counts: { rows: number; create: number; update: number; error: number; warnings: number }
}

async function buildPlan(actor: Actor, file: ImportFile, db: Db): Promise<ImportPlan> {
  const parsed = parseImportBuffer(await readFileBytes(file.storage_key!))
  const classes = (
    await q<ImportClass>("select id, key, name, is_active, attributes from ci_classes where tenant_id = $1", [actor.tenantId], db)
  ).map((c) => ({ ...c, attributes: readSchema(c.attributes) }))
  const normalized = parsed.records
    .map((cells, i) => ({ cells, line: parsed.lines[i] }))
    .filter((r) => r.cells.some((c) => c.trim()))
    .map((r) => normalizeRow(r.cells, parsed.columns, r.line))

  const codes = [...new Set(normalized.map((r) => r.values?.ci_code.toUpperCase()).filter((c): c is string => !!c))]
  const emails = [...new Set(normalized.map((r) => r.values?.owner_email).filter((e): e is string => !!e))]
  const [existingRows, users] = await Promise.all([
    codes.length
      ? q<CiRow & { code_key: string }>(
          `select ${CI_COLUMNS}, upper(trim(ci_code)) as code_key from configuration_items where tenant_id = $1 and upper(trim(ci_code)) = any($2::text[])`,
          [actor.tenantId, codes],
          db
        )
      : Promise.resolve([]),
    emails.length
      ? q<{ id: string; email: string }>("select id, lower(email) as email from users where tenant_id = $1 and status = 'active' and lower(email) = any($2::text[])", [actor.tenantId, emails], db)
      : Promise.resolve([]),
  ])
  const existing = new Map(existingRows.map((r) => [r.code_key, r]))
  const userByEmail = new Map(users.map((u) => [u.email, u.id]))
  const classById = new Map(classes.map((c) => [c.id, c]))
  const fallback = classes.find((c) => c.key === "other" && c.is_active) ?? classes.find((c) => c.is_active) ?? null
  const seen = new Map<string, number>()

  const rows: PlannedRow[] = normalized.map((n) => {
    const errors = [...n.errors]
    const warnings = [...n.warnings]
    const v = n.values
    const code = v?.ci_code ?? ""
    const key = code.toUpperCase()
    const ex = v ? existing.get(key) ?? null : null
    if (v) {
      const first = seen.get(key)
      if (first !== undefined) errors.push(`CI code ${code} is also on line ${first}; each code can appear once`)
      else seen.set(key, n.line)
    }
    let cls: ImportClass | null = ex ? classById.get(ex.class_id) ?? null : null
    if (n.classText) {
      const r = resolveClass(n.classText, classes)
      if (!r.cls) errors.push(`Class: no class matches "${n.classText.slice(0, 40)}"`)
      else if (!r.cls.is_active && r.cls.id !== ex?.class_id) errors.push(`Class: ${r.cls.name} is no longer in use`)
      else {
        cls = r.cls
        if (r.warning) warnings.push(r.warning)
      }
    } else if (!ex) {
      if (!fallback) errors.push("Class: the file has no class column and the tenant has no default class")
      else {
        cls = fallback
        warnings.push(`no class given; using ${fallback.name}`)
      }
    }
    let ownerId: string | null = null
    if (v?.owner_email) {
      ownerId = userByEmail.get(v.owner_email) ?? null
      if (!ownerId) warnings.push(`no active user has the email ${v.owner_email}; the owner was not set`)
    }
    if (v && !ex && !v.name) warnings.push("no name given; the CI code is used as the name")
    let attributes: Record<string, unknown> | null = null
    if (cls) {
      const a = rowAttributes(cls.attributes, ex?.attributes ?? {}, n.rawAttributes)
      errors.push(...a.errors.map((e) => `Attribute ${e}`))
      attributes = a.attributes
    }
    const ok = !!v && !!cls && errors.length === 0
    return {
      line: n.line,
      action: ok ? (ex ? "update" : "create") : "error",
      code,
      values: v,
      classId: cls?.id ?? null,
      className: cls?.name ?? null,
      ownerId,
      attributes,
      rawAttributes: n.rawAttributes,
      existing: ex,
      errors,
      warnings,
    }
  })
  return {
    file,
    delimiter: parsed.delimiter,
    columns: parsed.columns,
    rows,
    counts: {
      rows: rows.length,
      create: rows.filter((r) => r.action === "create").length,
      update: rows.filter((r) => r.action === "update").length,
      error: rows.filter((r) => r.action === "error").length,
      warnings: rows.filter((r) => r.warnings.length > 0).length,
    },
  }
}

export type ImportSummary = {
  file_id: string
  file_name: string
  rows: number
  created: number
  updated: number
  unchanged: number
  skipped: number
  errors: { line: number; message: string }[]
  warnings: { line: number; message: string }[]
}

/** The result of an earlier commit of this file, if any (kept in the audit log). */
async function previousCommit(actor: Actor, fileId: string, db: Db): Promise<{ at: Date; summary: ImportSummary } | null> {
  const row = await q1<{ created_at: Date; data: ImportSummary }>(
    "select created_at, data from audit_log where tenant_id = $1 and action = $2 and entity_type = 'import' and entity_id = $3 order by id desc limit 1",
    [actor.tenantId, IMPORT_ACTION, fileId],
    db
  )
  return row ? { at: row.created_at, summary: row.data } : null
}

export async function previewImport(actor: Actor, fileId: string, db: Db = pool()) {
  requireEdit(actor)
  const file = await loadFile(actor, fileId, db)
  const committed = await previousCommit(actor, file.id, db)
  if (committed) return { file, committed, plan: null }
  return { file, committed: null, plan: await buildPlan(actor, file, db) }
}

const MAX_REPORTED = 500

/** Upserts every valid row by CI code in one transaction. Rows with errors are skipped and reported. */
export async function commitImport(actor: Actor, fileId: string): Promise<ImportSummary> {
  requireEdit(actor)
  return tx(async (c) => {
    const file = await loadFile(actor, fileId, c, true)
    if (await previousCommit(actor, file.id, c)) throw new AppError("This file has already been imported. Upload it again to import it again.")
    const plan = await buildPlan(actor, file, c)
    const summary: ImportSummary = {
      file_id: file.id, file_name: file.file_name, rows: plan.rows.length, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [], warnings: [],
    }
    type Labels = { class: string | null; owner: string | null; support_group: string | null; organization: string | null }
    const labelCache = new Map<string, Labels>()
    const lookupLabels = async (r: { class_id: string; owner_id: string | null; support_group_id: string | null; organization_id: string | null }): Promise<Labels> => {
      const k = `${r.class_id}|${r.owner_id}|${r.support_group_id}|${r.organization_id}`
      const hit = labelCache.get(k)
      if (hit) return hit
      const row = await q1<Labels>(
        `select (select name from ci_classes where id = $2 and tenant_id = $1) as class,
                (select email from users where id = $3 and tenant_id = $1) as owner,
                (select name from groups where id = $4 and tenant_id = $1) as support_group,
                (select name from organizations where id = $5 and tenant_id = $1) as organization`,
        [actor.tenantId, r.class_id, r.owner_id, r.support_group_id, r.organization_id],
        c
      )
      const labels = row ?? { class: null, owner: null, support_group: null, organization: null }
      labelCache.set(k, labels)
      return labels
    }
    const history: { ci_id: string; action: string; changes: unknown }[] = []

    for (const r of plan.rows) {
      for (const w of r.warnings) if (summary.warnings.length < MAX_REPORTED) summary.warnings.push({ line: r.line, message: w })
      if (r.action === "error" || !r.values || !r.classId || !r.attributes) {
        summary.skipped++
        for (const e of r.errors) if (summary.errors.length < MAX_REPORTED) summary.errors.push({ line: r.line, message: e })
        continue
      }
      const v = r.values
      if (r.action === "create") {
        const row = await q1<CiRow>(
          `insert into configuration_items (tenant_id, class_id, ci_code, name, status, condition, environment, criticality, owner_id,
             location, room, department, manufacturer, model, serial_no, purchase_date, warranty_years, warranty_expiry, cost, notes,
             attributes, source)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, 'import')
           returning ${CI_COLUMNS}`,
          [
            actor.tenantId, r.classId, v.ci_code, v.name ?? v.ci_code, v.status ?? "in_use", v.condition ?? null, v.environment ?? null,
            v.criticality ?? null, r.ownerId, v.location ?? null, v.room ?? null, v.department ?? null, v.manufacturer ?? null,
            v.model ?? null, v.serial_no ?? null, v.purchase_date ?? null, v.warranty_years ?? null, v.warranty_expiry ?? null,
            v.cost ?? null, v.notes ?? null, JSON.stringify(r.attributes),
          ],
          c
        )
        const ci = row!
        if (ci.owner_id) await syncAssignment(c, ci, ci.owner_id, actor, "Owner set by CSV import")
        const labels = await lookupLabels(ci)
        history.push({ ci_id: ci.id, action: "import_created", changes: ciChanges(null, { ci, labels, attributes: ci.attributes }) })
        summary.created++
        continue
      }

      const ex = r.existing!
      const next: CiRow = {
        ...ex,
        class_id: r.classId,
        name: v.name ?? ex.name,
        status: v.status ?? ex.status,
        condition: v.condition ?? ex.condition,
        environment: v.environment ?? ex.environment,
        criticality: v.criticality ?? ex.criticality,
        owner_id: r.ownerId ?? ex.owner_id,
        location: v.location ?? ex.location,
        room: v.room ?? ex.room,
        department: v.department ?? ex.department,
        manufacturer: v.manufacturer ?? ex.manufacturer,
        model: v.model ?? ex.model,
        serial_no: v.serial_no ?? ex.serial_no,
        purchase_date: v.purchase_date ?? ex.purchase_date,
        warranty_years: v.warranty_years ?? ex.warranty_years,
        warranty_expiry: v.warranty_expiry ?? ex.warranty_expiry,
        cost: v.cost ?? ex.cost,
        notes: v.notes ?? ex.notes,
        attributes: r.attributes,
      }
      const changes = ciChanges(
        { ci: ex, labels: await lookupLabels(ex), attributes: ex.attributes },
        { ci: next, labels: await lookupLabels(next), attributes: next.attributes }
      )
      if (!hasChanges(changes)) {
        summary.unchanged++
        continue
      }
      await exec(
        `update configuration_items set class_id = $3, name = $4, status = $5, condition = $6, environment = $7, criticality = $8, owner_id = $9,
                location = $10, room = $11, department = $12, manufacturer = $13, model = $14, serial_no = $15, purchase_date = $16,
                warranty_years = $17, warranty_expiry = $18, cost = $19, notes = $20, attributes = $21, updated_at = now()
          where id = $1 and tenant_id = $2`,
        [
          ex.id, actor.tenantId, next.class_id, next.name, next.status, next.condition, next.environment, next.criticality, next.owner_id,
          next.location, next.room, next.department, next.manufacturer, next.model, next.serial_no, next.purchase_date,
          next.warranty_years, next.warranty_expiry, next.cost, next.notes, JSON.stringify(next.attributes),
        ],
        c
      )
      if (next.owner_id !== ex.owner_id) await syncAssignment(c, ex, next.owner_id, actor, "Owner set by CSV import")
      history.push({ ci_id: ex.id, action: "import_updated", changes })
      summary.updated++
    }

    for (let i = 0; i < history.length; i += 500) {
      const chunk = history.slice(i, i + 500)
      await exec(
        `insert into ci_history (tenant_id, ci_id, actor_id, action, changes)
         select $1, x.ci_id, $2, x.action, x.changes from jsonb_to_recordset($3::jsonb) as x(ci_id uuid, action text, changes jsonb)`,
        [actor.tenantId, actor.id, JSON.stringify(chunk)],
        c
      )
    }

    await audit(
      {
        tenantId: actor.tenantId,
        actor: { id: actor.id, email: actor.email },
        action: IMPORT_ACTION,
        entityType: "import",
        entityId: file.id,
        summary: `CSV import ${file.file_name}: ${summary.created} created, ${summary.updated} updated, ${summary.unchanged} unchanged, ${summary.skipped} skipped`.slice(0, 300),
        data: summary as unknown as Record<string, unknown>,
      },
      c
    )
    return summary
  })
}
