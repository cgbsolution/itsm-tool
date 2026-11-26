/**
 * Per-type ticket workflows (state machines). Replaces the legacy single
 * new → open ⇄ hold → closed lifecycle shared by every record type.
 * Safe to import in the browser (used to draw buttons) and on the server
 * (used to enforce the same rules).
 */
import type { TicketType } from "@/lib/itsm/vocab"

export const STATUSES = [
  "draft", "new", "assessment", "pending_approval", "approved", "scheduled",
  "in_progress", "investigating", "known_error", "implementing", "review",
  "on_hold", "resolved", "closed", "rejected", "cancelled",
] as const
export type Status = (typeof STATUSES)[number]

export const STATUS_LABELS: Record<Status, string> = {
  draft: "Draft",
  new: "New",
  assessment: "Assessment",
  pending_approval: "Awaiting approval",
  approved: "Approved",
  scheduled: "Scheduled",
  in_progress: "In progress",
  investigating: "Investigating",
  known_error: "Known error",
  implementing: "Implementing",
  review: "Post-implementation review",
  on_hold: "On hold",
  resolved: "Resolved",
  closed: "Closed",
  rejected: "Rejected",
  cancelled: "Cancelled",
}

/**
 * How a state affects the SLA clocks:
 *  open     – clocks run
 *  paused   – clocks paused (waiting on someone else)
 *  resolved – resolution clock stopped; resumes if reopened
 *  done     – terminal; clocks finalised
 */
export type StateCategory = "open" | "paused" | "resolved" | "done"
export const STATE_CATEGORY: Record<Status, StateCategory> = {
  draft: "paused",
  new: "open",
  assessment: "open",
  pending_approval: "paused",
  approved: "open",
  scheduled: "open",
  in_progress: "open",
  investigating: "open",
  known_error: "open",
  implementing: "open",
  review: "open",
  on_hold: "paused",
  resolved: "resolved",
  closed: "done",
  rejected: "done",
  cancelled: "done",
}

export function isTerminal(status: string): boolean {
  return STATE_CATEGORY[status as Status] === "done"
}
export function isActiveStatus(status: string): boolean {
  const c = STATE_CATEGORY[status as Status]
  return c === "open" || c === "paused"
}

/** Who may run a transition (checked together with ticket access rules). */
export type Actor = "worker" | "requester" | "system"

/** Extra input a transition needs from the form. */
export type Requirement =
  | "hold"          // reason + until
  | "resolution"    // code + notes
  | "comment"       // a reason (cancel, reject, reopen)
  | "workaround"
  | "root_cause"
  | "plan"          // change plans + window must be filled in
  | "outcome"       // change outcome

export type Transition = {
  action: string
  label: string
  from: Status[]
  to: Status
  by: Actor[]
  requires?: Requirement[]
  tone?: "primary" | "danger" | "default"
}

const incident: Transition[] = [
  { action: "start", label: "Start work", from: ["new"], to: "in_progress", by: ["worker"], tone: "primary" },
  { action: "hold", label: "Put on hold", from: ["new", "in_progress"], to: "on_hold", by: ["worker"], requires: ["hold"] },
  { action: "resume", label: "Resume", from: ["on_hold"], to: "in_progress", by: ["worker", "system"] },
  { action: "resolve", label: "Resolve", from: ["new", "in_progress", "on_hold"], to: "resolved", by: ["worker"], requires: ["resolution"], tone: "primary" },
  { action: "reopen", label: "Reopen", from: ["resolved"], to: "in_progress", by: ["worker", "requester"], requires: ["comment"] },
  { action: "close", label: "Close", from: ["resolved"], to: "closed", by: ["worker", "requester", "system"], tone: "primary" },
  { action: "reopen_closed", label: "Reopen", from: ["closed"], to: "in_progress", by: ["worker"], requires: ["comment"] },
  { action: "cancel", label: "Cancel", from: ["new", "in_progress", "on_hold"], to: "cancelled", by: ["worker", "requester"], requires: ["comment"], tone: "danger" },
]

const serviceRequest: Transition[] = [
  { action: "approve_system", label: "Approved", from: ["pending_approval"], to: "approved", by: ["system"] },
  { action: "reject_system", label: "Rejected", from: ["pending_approval"], to: "rejected", by: ["system"] },
  { action: "start", label: "Start fulfilment", from: ["new", "approved"], to: "in_progress", by: ["worker"], tone: "primary" },
  { action: "hold", label: "Put on hold", from: ["new", "approved", "in_progress"], to: "on_hold", by: ["worker"], requires: ["hold"] },
  { action: "resume", label: "Resume", from: ["on_hold"], to: "in_progress", by: ["worker", "system"] },
  { action: "resolve", label: "Mark fulfilled", from: ["new", "approved", "in_progress", "on_hold"], to: "resolved", by: ["worker"], requires: ["resolution"], tone: "primary" },
  { action: "reopen", label: "Reopen", from: ["resolved"], to: "in_progress", by: ["worker", "requester"], requires: ["comment"] },
  { action: "close", label: "Close", from: ["resolved"], to: "closed", by: ["worker", "requester", "system"], tone: "primary" },
  { action: "reopen_closed", label: "Reopen", from: ["closed"], to: "in_progress", by: ["worker"], requires: ["comment"] },
  { action: "cancel", label: "Cancel", from: ["new", "pending_approval", "approved", "in_progress", "on_hold"], to: "cancelled", by: ["worker", "requester"], requires: ["comment"], tone: "danger" },
]

const problem: Transition[] = [
  { action: "investigate", label: "Start investigation", from: ["new"], to: "investigating", by: ["worker"], tone: "primary" },
  { action: "known_error", label: "Record known error", from: ["investigating"], to: "known_error", by: ["worker"], requires: ["workaround"] },
  { action: "hold", label: "Put on hold", from: ["investigating", "known_error"], to: "on_hold", by: ["worker"], requires: ["hold"] },
  { action: "resume", label: "Resume", from: ["on_hold"], to: "investigating", by: ["worker", "system"] },
  { action: "resolve", label: "Resolve", from: ["investigating", "known_error", "on_hold"], to: "resolved", by: ["worker"], requires: ["root_cause"], tone: "primary" },
  { action: "reopen", label: "Reopen", from: ["resolved"], to: "investigating", by: ["worker"], requires: ["comment"] },
  { action: "close", label: "Close", from: ["resolved"], to: "closed", by: ["worker", "system"], tone: "primary" },
  { action: "cancel", label: "Cancel", from: ["new", "investigating", "known_error", "on_hold"], to: "cancelled", by: ["worker"], requires: ["comment"], tone: "danger" },
]

const change: Transition[] = [
  { action: "submit", label: "Submit for assessment", from: ["draft"], to: "assessment", by: ["worker"], requires: ["plan"], tone: "primary" },
  { action: "request_approval", label: "Request CAB approval", from: ["assessment"], to: "pending_approval", by: ["worker"], requires: ["plan"], tone: "primary" },
  { action: "preapproved", label: "Schedule (pre-approved)", from: ["assessment"], to: "scheduled", by: ["worker"], requires: ["plan"], tone: "primary" },
  { action: "approve_system", label: "Approved", from: ["pending_approval"], to: "scheduled", by: ["system"] },
  { action: "reject_system", label: "Rejected", from: ["pending_approval"], to: "rejected", by: ["system"] },
  { action: "revise", label: "Back to draft", from: ["assessment", "rejected", "scheduled"], to: "draft", by: ["worker"] },
  { action: "implement", label: "Start implementation", from: ["scheduled"], to: "implementing", by: ["worker"], tone: "primary" },
  { action: "complete", label: "Implementation done", from: ["implementing"], to: "review", by: ["worker"], requires: ["outcome"], tone: "primary" },
  { action: "close", label: "Close change", from: ["review"], to: "closed", by: ["worker"], tone: "primary" },
  { action: "cancel", label: "Cancel", from: ["draft", "assessment", "pending_approval", "scheduled"], to: "cancelled", by: ["worker"], requires: ["comment"], tone: "danger" },
]

export const WORKFLOWS: Record<TicketType, Transition[]> = {
  incident,
  service_request: serviceRequest,
  problem,
  change,
}

/** Statuses each type can be in (for filters and validation). */
export const TYPE_STATUSES: Record<TicketType, Status[]> = {
  incident: ["new", "in_progress", "on_hold", "resolved", "closed", "cancelled"],
  service_request: ["new", "pending_approval", "approved", "in_progress", "on_hold", "resolved", "closed", "rejected", "cancelled"],
  problem: ["new", "investigating", "known_error", "on_hold", "resolved", "closed", "cancelled"],
  change: ["draft", "assessment", "pending_approval", "scheduled", "implementing", "review", "closed", "rejected", "cancelled"],
}

export function initialStatus(type: TicketType, opts: { needsApproval?: boolean } = {}): Status {
  if (type === "change") return "draft"
  if (type === "service_request" && opts.needsApproval) return "pending_approval"
  return "new"
}

export function findTransition(type: TicketType, action: string): Transition | undefined {
  return WORKFLOWS[type].find((t) => t.action === action)
}

/** Transitions available from a status for a kind of actor. */
export function availableTransitions(type: TicketType, status: string, as: Actor[]): Transition[] {
  return WORKFLOWS[type].filter((t) => t.from.includes(status as Status) && t.by.some((b) => as.includes(b)))
}

/** The status a ticket goes to when an engineer picks it up. */
export function workingStatus(type: TicketType, status: string): Status | null {
  if (type === "incident" && status === "new") return "in_progress"
  if (type === "service_request" && (status === "new" || status === "approved")) return "in_progress"
  if (type === "problem" && status === "new") return "investigating"
  return null
}

/** Old helpdesk statuses → new ones (data migration). */
export function legacyStatus(status: string | null | undefined): Status {
  switch ((status ?? "new").toLowerCase()) {
    case "open":
    case "in_progress":
      return "in_progress"
    case "hold":
    case "on_hold":
      return "on_hold"
    case "closed":
      return "closed"
    case "resolved":
      return "resolved"
    default:
      return "new"
  }
}
