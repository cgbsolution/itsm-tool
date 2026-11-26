/** Tabs shared by the ITSM settings pages (server component). */
import { Tabs } from "@/components/ui"

export const ITSM_TABS = [
  { key: "categories", label: "Categories" },
  { key: "priority", label: "Priority matrix" },
  { key: "sla", label: "SLA & OLA" },
  { key: "calendar", label: "Calendar & behaviour" },
  { key: "fields", label: "Custom fields" },
  { key: "templates", label: "Email templates" },
  { key: "windows", label: "Maintenance windows" },
] as const

export type ItsmTab = (typeof ITSM_TABS)[number]["key"]

export function ItsmTabs({ active }: { active?: ItsmTab }) {
  return <Tabs items={ITSM_TABS.map((t) => ({ href: `/admin/itsm/${t.key}`, label: t.label, active: t.key === active }))} />
}
