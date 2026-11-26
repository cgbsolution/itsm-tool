/** Small form pieces shared by the ITSM settings pages (server components). */
import type { ReactNode } from "react"
import { TICKET_TYPES, TICKET_TYPE_LABELS, type TicketType } from "@/lib/itsm/vocab"

/** Record-type checkboxes. null (every type) shows all ticked; none ticked also means every type. */
export function TypeChecks({ selected, name = "ticketTypes", compact }: { selected: readonly TicketType[] | null; name?: string; compact?: boolean }) {
  return (
    <div className={compact ? "flex flex-wrap gap-x-3 gap-y-1" : "flex flex-wrap gap-x-4 gap-y-1.5"}>
      {TICKET_TYPES.map((t) => (
        <label key={t} className="flex items-center gap-1.5 text-xs text-slate-700">
          <input type="checkbox" name={name} value={t} defaultChecked={!selected || selected.includes(t)} />
          {TICKET_TYPE_LABELS[t]}
        </label>
      ))}
    </div>
  )
}

export function typesLabel(types: readonly TicketType[] | null): string {
  if (!types || types.length === 0 || types.length === TICKET_TYPES.length) return "All record types"
  return types.map((t) => TICKET_TYPE_LABELS[t]).join(", ")
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="mb-4 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-800 ring-1 ring-blue-200">{children}</p>
}
