/** Form values (from formObject) → service input, with user-readable errors. */
import { AppError } from "@/lib/errors"
import { prefixed } from "@/lib/validate"
import { parseAttributeSchema, type SchemaRowInput } from "@/lib/cmdb/attributes"
import type { CiAttribute } from "@/lib/cmdb/classes"
import { cleanText, parseDateInput, parseIntInput, parseNumberInput } from "@/lib/cmdb/values"
import type { CiInput } from "@/lib/cmdb/service"

function field<T>(label: string, fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    throw new AppError(`${label}: ${(e as Error).message}`)
  }
}

const optional = (v: unknown) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim())

/** Every field of the CI form (empty values clear the field). */
export function ciInputFromForm(o: Record<string, unknown>): CiInput {
  return {
    classId: String(o.classId ?? ""),
    ciCode: String(o.ciCode ?? ""),
    name: String(o.name ?? ""),
    status: (optional(o.status) ?? undefined) as CiInput["status"],
    condition: optional(o.condition) as CiInput["condition"],
    environment: optional(o.environment) as CiInput["environment"],
    criticality: optional(o.criticality) as CiInput["criticality"],
    ownerId: optional(o.ownerId),
    supportGroupId: optional(o.supportGroupId),
    organizationId: optional(o.organizationId),
    location: cleanText(o.location, 200),
    room: cleanText(o.room, 100),
    department: cleanText(o.department, 200),
    manufacturer: cleanText(o.manufacturer, 200),
    model: cleanText(o.model, 200),
    serialNo: cleanText(o.serialNo, 120),
    purchaseDate: field("Purchase date", () => parseDateInput(o.purchaseDate)),
    warrantyYears: field("Warranty years", () => parseIntInput(o.warrantyYears, 0, 50)),
    warrantyExpiry: field("Warranty expiry", () => parseDateInput(o.warrantyExpiry)),
    cost: field("Cost", () => parseNumberInput(o.cost)),
    notes: cleanText(o.notes, 10_000),
    attributes: prefixed(o, "attr"),
  }
}

/** The class editor's rows: inputs named a.<index>.<key|label|type|options|required>. */
export function attributeSchemaFromForm(o: Record<string, unknown>): CiAttribute[] {
  const rows = new Map<number, SchemaRowInput>()
  for (const [k, v] of Object.entries(o)) {
    const m = /^a\.(\d{1,3})\.(key|label|type|options|required)$/.exec(k)
    if (!m) continue
    const i = Number(m[1])
    const row = rows.get(i) ?? {}
    row[m[2] as keyof SchemaRowInput] = Array.isArray(v) ? v[v.length - 1] : v
    rows.set(i, row)
  }
  const ordered = [...rows.entries()].sort(([a], [b]) => a - b).map(([, r]) => r)
  try {
    return parseAttributeSchema(ordered)
  } catch (e) {
    throw new AppError((e as Error).message)
  }
}
