/** CMDB vocabulary: statuses, conditions, relationship types and their labels. */

export const CI_STATUSES = ["planned", "in_stock", "in_use", "maintenance", "retired", "disposed"] as const
export type CiStatus = (typeof CI_STATUSES)[number]
export const CI_STATUS_LABELS: Record<CiStatus, string> = {
  planned: "Planned",
  in_stock: "In stock",
  in_use: "In use",
  maintenance: "Maintenance",
  retired: "Retired",
  disposed: "Disposed",
}

export const CI_CONDITIONS = ["new", "good", "fair", "poor", "damaged"] as const
export type CiCondition = (typeof CI_CONDITIONS)[number]

export const CI_ENVIRONMENTS = ["production", "staging", "test", "development"] as const
export type CiEnvironment = (typeof CI_ENVIRONMENTS)[number]

export const CI_CRITICALITIES = ["low", "medium", "high", "critical"] as const
export type CiCriticality = (typeof CI_CRITICALITIES)[number]

export const CLASS_CATEGORIES = ["hardware", "software", "service", "network", "facility", "other"] as const
export type ClassCategory = (typeof CLASS_CATEGORIES)[number]

export const REL_TYPES = ["depends_on", "runs_on", "hosted_on", "connected_to", "contains", "installed_on", "uses", "backs_up", "member_of"] as const
export type RelType = (typeof REL_TYPES)[number]

/** How a relationship reads from the source ("out") and from the target ("in"). */
export const REL_LABELS: Record<RelType, { out: string; in: string }> = {
  depends_on: { out: "Depends on", in: "Depended on by" },
  runs_on: { out: "Runs on", in: "Runs" },
  hosted_on: { out: "Hosted on", in: "Hosts" },
  connected_to: { out: "Connected to", in: "Connected from" },
  contains: { out: "Contains", in: "Contained in" },
  installed_on: { out: "Installed on", in: "Has installed" },
  uses: { out: "Uses", in: "Used by" },
  backs_up: { out: "Backs up", in: "Backed up by" },
  member_of: { out: "Member of", in: "Has member" },
}

/**
 * Relationship types that mean "the source needs the target": if the target
 * fails, the source is affected. `contains` reads the other way round (a
 * contained item needs its container). `connected_to` and `backs_up` are not
 * followed by impact analysis.
 */
export const DEPENDENCY_TYPES: RelType[] = ["depends_on", "runs_on", "hosted_on", "installed_on", "uses", "member_of"]
export const REVERSED_DEPENDENCY_TYPES: RelType[] = ["contains"]

export const IMPACT_MAX_DEPTH = 5

export function isRelType(v: unknown): v is RelType {
  return typeof v === "string" && (REL_TYPES as readonly string[]).includes(v)
}
export function isCiStatus(v: unknown): v is CiStatus {
  return typeof v === "string" && (CI_STATUSES as readonly string[]).includes(v)
}

export const HISTORY_LABELS: Record<string, string> = {
  created: "created the item",
  updated: "updated fields",
  retired: "retired the item",
  deleted: "deleted the item",
  relationship_added: "added a relationship",
  relationship_removed: "removed a relationship",
  assigned: "assigned it",
  returned: "recorded its return",
  import_created: "created it by CSV import",
  import_updated: "updated it by CSV import",
  agent_created: "created it from agent inventory",
  agent_updated: "updated it from agent inventory",
}

/** Field names shown in history and import previews. */
export const FIELD_LABELS: Record<string, string> = {
  ci_code: "CI code",
  name: "Name",
  class: "Class",
  status: "Status",
  condition: "Condition",
  environment: "Environment",
  criticality: "Criticality",
  owner: "Owner",
  owner_email: "Owner email",
  support_group: "Support group",
  organization: "Organisation",
  location: "Location",
  room: "Room",
  department: "Department",
  manufacturer: "Manufacturer",
  model: "Model",
  serial_no: "Serial number",
  purchase_date: "Purchase date",
  warranty_years: "Warranty (years)",
  warranty_expiry: "Warranty expiry",
  cost: "Cost",
  notes: "Notes",
  source: "Source",
  relationship: "Relationship",
  assignment: "Assignment",
}
