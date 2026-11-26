"use client"
/** Rows of key / label / type / options / required for a CI class (inputs named a.<n>.<field>). */
import { useState } from "react"

type Row = { id: number; key: string; label: string; type: string; options: string; required: boolean }
export type EditorAttribute = { key: string; label: string; type: string; options?: string[]; required?: boolean }

const TYPES = [
  ["text", "Text"],
  ["number", "Number"],
  ["date", "Date"],
  ["select", "Select (options)"],
  ["boolean", "Yes / no"],
] as const

let nextId = 1
const blank = (): Row => ({ id: nextId++, key: "", label: "", type: "text", options: "", required: false })

export function AttributeEditor({ initial }: { initial: EditorAttribute[] }) {
  const [rows, setRows] = useState<Row[]>(() =>
    initial.length
      ? initial.map((a) => ({ id: nextId++, key: a.key, label: a.label, type: a.type, options: (a.options ?? []).join(", "), required: !!a.required }))
      : [blank()]
  )
  const update = (id: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const move = (index: number, by: number) =>
    setRows((rs) => {
      const to = index + by
      if (to < 0 || to >= rs.length) return rs
      const copy = [...rs]
      ;[copy[index], copy[to]] = [copy[to], copy[index]]
      return copy
    })

  return (
    <div className="space-y-2">
      <div className="hidden grid-cols-[10rem_1fr_9rem_1fr_5rem_5.5rem] gap-2 px-1 text-xs font-medium text-slate-500 md:grid">
        <span>Key</span>
        <span>Label</span>
        <span>Type</span>
        <span>Options (for select, comma-separated)</span>
        <span>Required</span>
        <span />
      </div>
      {rows.map((r, i) => (
        <div key={r.id} className="grid gap-2 rounded-md border border-slate-200 p-2 md:grid-cols-[10rem_1fr_9rem_1fr_5rem_5.5rem] md:items-center md:border-0 md:p-0">
          <input
            name={`a.${i}.key`}
            value={r.key}
            onChange={(e) => update(r.id, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}
            className="input font-mono text-xs"
            placeholder="e.g. cpu"
            pattern="[a-z][a-z0-9_]{0,40}"
            title="Start with a lower-case letter; use a-z, 0-9 and _ (up to 41 characters)"
            maxLength={41}
            aria-label={`Attribute ${i + 1} key`}
          />
          <input name={`a.${i}.label`} value={r.label} onChange={(e) => update(r.id, { label: e.target.value })} className="input" placeholder="Label" maxLength={100} aria-label={`Attribute ${i + 1} label`} />
          <select name={`a.${i}.type`} value={r.type} onChange={(e) => update(r.id, { type: e.target.value })} className="input" aria-label={`Attribute ${i + 1} type`}>
            {TYPES.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          <input
            name={`a.${i}.options`}
            value={r.options}
            onChange={(e) => update(r.id, { options: e.target.value })}
            className="input"
            placeholder={r.type === "select" ? "router, switch, firewall" : "—"}
            disabled={r.type !== "select"}
            aria-label={`Attribute ${i + 1} options`}
          />
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" name={`a.${i}.required`} checked={r.required} onChange={(e) => update(r.id, { required: e.target.checked })} /> <span className="md:sr-only">Required</span>
          </label>
          <div className="flex gap-1">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label="Move down">↓</button>
            <button type="button" className="btn btn-ghost btn-sm text-red-600" onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.id !== r.id) : [blank()]))} aria-label="Remove attribute">✕</button>
          </div>
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={() => setRows((rs) => [...rs, blank()])}>
        Add attribute
      </button>
      <p className="hint">Removing an attribute does not delete values already stored on items; they are shown as extra attributes.</p>
    </div>
  )
}
