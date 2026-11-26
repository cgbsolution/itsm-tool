/** CMDB view helpers (server components). */
import type { ReactNode } from "react"
import { Badge, Field, type Tone } from "@/components/ui"
import type { CiAttribute } from "@/lib/cmdb/classes"
import { formatAttribute } from "@/lib/cmdb/attributes"
import { warrantyState } from "@/lib/cmdb/values"
import { formatDate } from "@/lib/format"
import {
  CI_CONDITIONS, CI_CRITICALITIES, CI_ENVIRONMENTS, CI_STATUSES, CI_STATUS_LABELS, FIELD_LABELS, type CiStatus,
} from "@/lib/cmdb/vocab"

const cap = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())

export function CiStatusBadge({ status }: { status: string }) {
  const tone: Tone =
    status === "in_use" ? "green" : status === "in_stock" ? "blue" : status === "maintenance" ? "amber" : status === "disposed" ? "red" : status === "planned" ? "purple" : "gray"
  return <Badge tone={tone}>{CI_STATUS_LABELS[status as CiStatus] ?? cap(status)}</Badge>
}

export function WarrantyBadge({ expiry, today }: { expiry: string | null; today: string }) {
  const w = warrantyState(expiry, today)
  if (w.state === "none") return <span className="text-xs text-slate-400">—</span>
  return (
    <span className="flex flex-wrap items-center gap-1.5 whitespace-nowrap">
      <span className="text-xs text-slate-600">{formatDate(expiry)}</span>
      {w.state === "expired" && <Badge tone="red">Expired</Badge>}
      {w.state === "expiring" && <Badge tone="amber">{w.days === 0 ? "Ends today" : `${w.days} d left`}</Badge>}
    </span>
  )
}

export function labelFor(key: string, schema: CiAttribute[] = []): string {
  if (key.startsWith("attributes.")) {
    const k = key.slice("attributes.".length)
    return schema.find((a) => a.key === k)?.label ?? cap(k)
  }
  return FIELD_LABELS[key] ?? cap(key)
}

/** A ci_history changes object as a list of "field: from → to". User text is rendered as text. */
export function ChangeList({ changes, schema }: { changes: Record<string, { from: unknown; to: unknown }> | null; schema?: CiAttribute[] }) {
  if (!changes || typeof changes !== "object") return null
  const entries = Object.entries(changes).slice(0, 40)
  if (!entries.length) return null
  const show = (v: unknown, key: string) => {
    if (key === "status" && typeof v === "string") return CI_STATUS_LABELS[v as CiStatus] ?? v
    const s = formatAttribute(v)
    return s.length > 120 ? s.slice(0, 120) + "…" : s
  }
  const has = (x: unknown) => x !== null && x !== undefined
  return (
    <ul className="mt-0.5 space-y-0.5 text-xs text-slate-600">
      {entries.map(([k, c]) => (
        <li key={k} className="break-words">
          <span className="text-slate-500">{labelFor(k, schema)}:</span>{" "}
          {has(c?.from) && <span className="line-through decoration-slate-300">{show(c.from, k)}</span>}
          {has(c?.from) && has(c?.to) && " → "}
          {has(c?.to) ? <span>{show(c.to, k)}</span> : has(c?.from) ? <span className="text-slate-400"> ({k === "relationship" ? "removed" : "cleared"})</span> : "—"}
        </li>
      ))}
    </ul>
  )
}

/** Inputs for a class's attribute schema, named attr.<key>. */
export function AttributeInputs({ schema, values }: { schema: CiAttribute[]; values?: Record<string, unknown> }) {
  if (!schema.length) return <p className="text-sm text-slate-500">This class has no attributes.</p>
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {schema.map((a) => {
        const name = `attr.${a.key}`
        const id = `attr-${a.key}`
        const v = values?.[a.key]
        let control: ReactNode
        switch (a.type) {
          case "number":
            control = <input id={id} name={name} type="number" step="any" className="input" required={a.required} defaultValue={typeof v === "number" ? v : v ? String(v) : ""} />
            break
          case "date":
            control = <input id={id} name={name} type="date" className="input" required={a.required} defaultValue={typeof v === "string" ? v : ""} />
            break
          case "boolean":
            control = (
              <select id={id} name={name} className="input" required={a.required} defaultValue={v === true ? "yes" : v === false ? "no" : ""}>
                <option value="">—</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            )
            break
          case "select":
            control = (
              <select id={id} name={name} className="input" required={a.required} defaultValue={typeof v === "string" ? v : ""}>
                <option value="">—</option>
                {(a.options ?? []).map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
                {typeof v === "string" && v && !(a.options ?? []).includes(v) && <option value={v}>{v} (not an option any more)</option>}
              </select>
            )
            break
          default:
            control = <input id={id} name={name} className="input" maxLength={2000} required={a.required} defaultValue={v === undefined || v === null ? "" : String(v)} />
        }
        return (
          <Field key={a.key} label={a.label} htmlFor={id} required={a.required}>
            {control}
          </Field>
        )
      })}
    </div>
  )
}

export type CiFormDefaults = Partial<{
  ci_code: string
  name: string
  status: string
  condition: string | null
  environment: string | null
  criticality: string | null
  owner_id: string | null
  support_group_id: string | null
  organization_id: string | null
  location: string | null
  room: string | null
  department: string | null
  manufacturer: string | null
  model: string | null
  serial_no: string | null
  purchase_date: string | null
  warranty_years: number | null
  warranty_expiry: string | null
  cost: number | null
  notes: string | null
  attributes: Record<string, unknown>
}>

type Option = { id: string; name: string }

function Select({ id, label, options, value, empty = "—" }: { id: string; label: string; options: { value: string; label: string }[]; value?: string | null; empty?: string }) {
  return (
    <Field label={label} htmlFor={id}>
      <select id={id} name={id} className="input" defaultValue={value ?? ""}>
        <option value="">{empty}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </Field>
  )
}

function Text({ id, label, value, max = 200, hint, required }: { id: string; label: string; value?: string | null; max?: number; hint?: string; required?: boolean }) {
  return (
    <Field label={label} htmlFor={id} hint={hint} required={required}>
      <input id={id} name={id} className="input" maxLength={max} required={required} defaultValue={value ?? ""} />
    </Field>
  )
}

/** The CI form body (create and edit). */
export function CiFields({
  schema,
  defaults = {},
  users,
  groups,
  organizations,
}: {
  schema: CiAttribute[]
  defaults?: CiFormDefaults
  users: { id: string; full_name: string; email: string }[]
  groups: Option[]
  organizations: Option[]
}) {
  const opts = (list: readonly string[]) => list.map((v) => ({ value: v, label: cap(v) }))
  return (
    <div className="space-y-4">
      <section className="card card-body space-y-3">
        <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
          <Text id="ciCode" label="CI code" value={defaults.ci_code} max={64} required hint="Unique in your organisation, e.g. LAP-0042" />
          <Text id="name" label="Name" value={defaults.name} required />
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Status" htmlFor="status" required>
            <select id="status" name="status" className="input" defaultValue={defaults.status ?? "in_use"}>
              {CI_STATUSES.map((s) => (
                <option key={s} value={s}>{CI_STATUS_LABELS[s]}</option>
              ))}
            </select>
          </Field>
          <Select id="condition" label="Condition" options={opts(CI_CONDITIONS)} value={defaults.condition} />
          <Select id="environment" label="Environment" options={opts(CI_ENVIRONMENTS)} value={defaults.environment} />
          <Select id="criticality" label="Criticality" options={opts(CI_CRITICALITIES)} value={defaults.criticality} />
        </div>
      </section>

      <section className="card card-body space-y-3">
        <h2 className="text-sm">Ownership</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Select
            id="ownerId"
            label="Owner (person using it)"
            options={users.map((u) => ({ value: u.id, label: u.full_name ? `${u.full_name} · ${u.email}` : u.email }))}
            value={defaults.owner_id}
            empty="— Nobody —"
          />
          <Select id="supportGroupId" label="Support group" options={groups.map((g) => ({ value: g.id, label: g.name }))} value={defaults.support_group_id} />
          <Select id="organizationId" label="Organisation" options={organizations.map((o) => ({ value: o.id, label: o.name }))} value={defaults.organization_id} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Text id="location" label="Location" value={defaults.location} />
          <Text id="room" label="Room" value={defaults.room} max={100} />
          <Text id="department" label="Department" value={defaults.department} />
        </div>
      </section>

      <section className="card card-body space-y-3">
        <h2 className="text-sm">Hardware and purchase</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Text id="manufacturer" label="Manufacturer" value={defaults.manufacturer} />
          <Text id="model" label="Model" value={defaults.model} />
          <Text id="serialNo" label="Serial number" value={defaults.serial_no} max={120} />
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Purchase date" htmlFor="purchaseDate">
            <input id="purchaseDate" name="purchaseDate" type="date" className="input" defaultValue={defaults.purchase_date ?? ""} />
          </Field>
          <Field label="Warranty (years)" htmlFor="warrantyYears">
            <input id="warrantyYears" name="warrantyYears" type="number" min={0} max={50} step={1} className="input" defaultValue={defaults.warranty_years ?? ""} />
          </Field>
          <Field label="Warranty expiry" htmlFor="warrantyExpiry" hint="Left empty, it is worked out from the purchase date and years.">
            <input id="warrantyExpiry" name="warrantyExpiry" type="date" className="input" defaultValue={defaults.warranty_expiry ?? ""} />
          </Field>
          <Field label="Cost" htmlFor="cost">
            <input id="cost" name="cost" type="number" min={0} step="0.01" className="input" defaultValue={defaults.cost ?? ""} />
          </Field>
        </div>
        <Field label="Notes" htmlFor="notes">
          <textarea id="notes" name="notes" rows={3} maxLength={10_000} className="input" defaultValue={defaults.notes ?? ""} />
        </Field>
      </section>

      <section className="card card-body space-y-3">
        <h2 className="text-sm">Attributes</h2>
        <AttributeInputs schema={schema} values={defaults.attributes} />
      </section>
    </div>
  )
}
