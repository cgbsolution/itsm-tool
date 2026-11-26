/**
 * ITSM vocabulary. Ported from the legacy helpdesk (src/lib/itsm.ts) and
 * extended. Safe to import in the browser and on the server.
 */

export const TICKET_TYPES = ["incident", "service_request", "problem", "change"] as const
export type TicketType = (typeof TICKET_TYPES)[number]

export const TICKET_TYPE_LABELS: Record<TicketType, string> = {
  incident: "Incident",
  service_request: "Service Request",
  problem: "Problem",
  change: "Change",
}

export const TICKET_TYPE_PREFIX: Record<TicketType, string> = {
  incident: "INC",
  service_request: "REQ",
  problem: "PRB",
  change: "CHG",
}

/** What a requester (not IT staff) may raise directly. */
export const REQUESTER_TICKET_TYPES: readonly TicketType[] = ["incident", "service_request"]

export function isTicketType(v: unknown): v is TicketType {
  return typeof v === "string" && (TICKET_TYPES as readonly string[]).includes(v)
}

export function typeFromNumber(number: string): TicketType | null {
  const prefix = number.slice(0, 3).toUpperCase()
  const entry = Object.entries(TICKET_TYPE_PREFIX).find(([, p]) => p === prefix)
  return entry ? (entry[0] as TicketType) : null
}

export const LEVELS = ["low", "medium", "high"] as const
export type Level = (typeof LEVELS)[number]

export const PRIORITIES = ["low", "medium", "high", "critical"] as const
export type Priority = (typeof PRIORITIES)[number]

export const PRIORITY_LABELS: Record<Priority, string> = {
  critical: "P1 · Critical",
  high: "P2 · High",
  medium: "P3 · Medium",
  low: "P4 · Low",
}

export const IMPACT_LABELS: Record<Level, string> = {
  high: "High: many people or a whole site",
  medium: "Medium: a team or department",
  low: "Low: one person",
}

export const URGENCY_LABELS: Record<Level, string> = {
  high: "High: work has stopped",
  medium: "Medium: work is slowed down",
  low: "Low: can wait",
}

export const CHANGE_TYPES = ["standard", "normal", "emergency"] as const
export type ChangeType = (typeof CHANGE_TYPES)[number]
export const CHANGE_TYPE_LABELS: Record<ChangeType, string> = {
  standard: "Standard (pre-approved)",
  normal: "Normal (CAB approval)",
  emergency: "Emergency (expedited approval)",
}

export const RISKS = ["low", "medium", "high"] as const
export type Risk = (typeof RISKS)[number]

export const CHANGE_OUTCOMES = ["successful", "partially_successful", "failed", "backed_out"] as const
export type ChangeOutcome = (typeof CHANGE_OUTCOMES)[number]

export const LINK_TYPES = ["related", "caused_by", "duplicate_of", "implements", "parent_of"] as const
export type LinkType = (typeof LINK_TYPES)[number]

export const LINK_TYPE_LABELS: Record<LinkType, string> = {
  related: "Related to",
  caused_by: "Caused by",
  duplicate_of: "Duplicate of",
  implements: "Implemented by change",
  parent_of: "Parent of",
}

export const RESOLUTION_CODES = [
  "Solved (permanently)",
  "Solved (workaround)",
  "Fulfilled",
  "Not reproducible",
  "Duplicate",
  "No response from requester",
  "Out of scope",
] as const

export const SOURCES = ["portal", "email", "phone", "agent", "api", "monitoring", "migration"] as const
export type Source = (typeof SOURCES)[number]

export function isLevel(v: unknown): v is Level {
  return typeof v === "string" && (LEVELS as readonly string[]).includes(v)
}
export function isPriority(v: unknown): v is Priority {
  return typeof v === "string" && (PRIORITIES as readonly string[]).includes(v)
}

export type MatrixCell = { impact: Level; urgency: Level; priority: Priority }

/** Priority from the tenant's matrix; the ITIL default when a cell is missing. */
export function priorityFromMatrix(matrix: MatrixCell[], impact: Level, urgency: Level): Priority {
  const cell = matrix.find((c) => c.impact === impact && c.urgency === urgency)
  if (cell) return cell.priority
  const score = LEVELS.indexOf(impact) + LEVELS.indexOf(urgency) // 0..4
  return (["low", "low", "medium", "high", "critical"] as const)[score]
}

/** Default categories for a new tenant (the legacy seed). */
export const DEFAULT_CATEGORIES: { name: string; types: TicketType[] | null; subs: string[] }[] = [
  { name: "Access & Identity", types: null, subs: ["Password Reset", "Account Locked", "New User Access", "Role / Permission Change", "SSO Login Issues"] },
  { name: "Hardware", types: null, subs: ["Laptop Issue", "Desktop Issue", "Monitor", "Keyboard / Mouse", "Printer / Scanner", "Hardware Replacement"] },
  { name: "Software / Applications", types: null, subs: ["Application Not Working", "Software Installation Request", "License Request", "Update / Patch Issue", "Compatibility Issue", "Internal / Custom Application"] },
  { name: "Network & Connectivity", types: null, subs: ["No Internet", "VPN Issues", "Wi-Fi Slow / Unstable", "LAN Issue", "Firewall / Port Access Request", "DNS Issue"] },
  { name: "Email & Collaboration", types: null, subs: ["Email Not Sending / Receiving", "Mailbox Full", "Outlook / Gmail Issues", "Teams / Slack Issues", "Calendar / Meeting Issue", "Shared Mailbox Access"] },
  { name: "Security", types: null, subs: ["Phishing / Suspicious Email", "Malware / Virus", "Device Compromised", "Security Access Request", "Data Loss Incident", "Policy Violation"] },
  { name: "Database", types: null, subs: ["Database Down", "Query Performance Issue", "Database Access Request", "Backup / Restore"] },
  { name: "Service Requests", types: ["service_request"], subs: ["New Laptop Request", "Software Installation", "VPN Access", "Email Group Creation"] },
]

/** The usual ITIL 3×3 matrix. */
export const DEFAULT_MATRIX: MatrixCell[] = [
  { impact: "high", urgency: "high", priority: "critical" },
  { impact: "high", urgency: "medium", priority: "high" },
  { impact: "high", urgency: "low", priority: "medium" },
  { impact: "medium", urgency: "high", priority: "high" },
  { impact: "medium", urgency: "medium", priority: "medium" },
  { impact: "medium", urgency: "low", priority: "low" },
  { impact: "low", urgency: "high", priority: "medium" },
  { impact: "low", urgency: "medium", priority: "low" },
  { impact: "low", urgency: "low", priority: "low" },
]

/** Sensible default SLA targets (minutes) for a new tenant, business hours. */
export const DEFAULT_SLA: Record<Priority, { response: number; resolution: number; businessHours: boolean }> = {
  critical: { response: 15, resolution: 240, businessHours: false },
  high: { response: 30, resolution: 480, businessHours: false },
  medium: { response: 120, resolution: 1440, businessHours: true },
  low: { response: 480, resolution: 4320, businessHours: true },
}

/** Short display reference: the number, or an id stub. */
export function ticketRef(t: { number?: string | null; id: string }): string {
  return t.number || `#${t.id.slice(0, 8).toUpperCase()}`
}

export function humanize(v: string | null | undefined): string {
  if (!v) return ""
  return v.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())
}
