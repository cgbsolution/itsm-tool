"use server"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { requireActor } from "@/lib/auth/session"
import { q, tx } from "@/lib/db"
import { fail, ok, type FormState } from "@/lib/actions"
import { formObject, parseLocalDateTime, prefixed, str, bool } from "@/lib/validate"
import { AppError } from "@/lib/errors"
import {
  acquireTicket,
  addComment,
  addTask,
  assignTicket,
  createTicket,
  deleteTicket,
  linkCi,
  linkTickets,
  setTaskStatus,
  setWatching,
  transitionTicket,
  unlinkCi,
  unlinkTickets,
  updateTicket,
  type CreateTicketInput,
} from "@/lib/itsm/tickets"
import { saveUploads } from "@/lib/files/storage"

async function ciIdsFromCodes(tenantId: string, raw: unknown): Promise<string[]> {
  const codes = String(raw ?? "")
    .split(/[,\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!codes.length) return []
  const rows = await q<{ id: string; code: string }>(
    "select id, upper(trim(ci_code)) as code from configuration_items where tenant_id = $1 and upper(trim(ci_code)) = any($2::text[])",
    [tenantId, codes.map((c) => c.toUpperCase())]
  )
  const missing = codes.filter((c) => !rows.some((r) => r.code === c.toUpperCase()))
  if (missing.length) throw new AppError(`Unknown configuration item: ${missing.join(", ")}`)
  return rows.map((r) => r.id)
}

function changeFields(o: Record<string, unknown>, tz: string) {
  return {
    changeType: o.changeType as CreateTicketInput["changeType"],
    risk: o.risk as CreateTicketInput["risk"],
    justification: str(o.justification, 50_000),
    implementationPlan: str(o.implementationPlan, 50_000),
    backoutPlan: str(o.backoutPlan, 50_000),
    testPlan: str(o.testPlan, 50_000),
    plannedStart: parseLocalDateTime(o.plannedStart, tz),
    plannedEnd: parseLocalDateTime(o.plannedEnd, tz),
    cabGroupId: str(o.cabGroupId),
  }
}

export async function createTicketAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  let number: string
  try {
    const o = formObject(fd)
    const tz = actor.tenant.timezone
    const type = String(o.type ?? "incident") as CreateTicketInput["type"]
    const input: CreateTicketInput = {
      type,
      subject: String(o.subject ?? ""),
      description: str(o.description, 50_000),
      requesterId: str(o.requesterId),
      categoryId: str(o.categoryId),
      impact: o.impact as CreateTicketInput["impact"],
      urgency: o.urgency as CreateTicketInput["urgency"],
      priority: o.priority as CreateTicketInput["priority"],
      assignmentGroupId: str(o.assignmentGroupId),
      assigneeId: str(o.assigneeId),
      contact: str(o.contact, 200),
      location: str(o.location, 200),
      custom: prefixed(o, "custom"),
      ciIds: await ciIdsFromCodes(actor.tenantId, o.ciCodes),
      workaround: str(o.workaround, 50_000),
      ...(type === "change" ? changeFields(o, tz) : {}),
    }
    const t = await tx(async (db) => {
      const created = await createTicket(actor, input, db)
      await saveUploads(fd.getAll("files"), { tenantId: actor.tenantId, entityType: "ticket", entityId: created.id, uploadedBy: actor.id }, db)
      return created
    })
    number = t.number
  } catch (e) {
    return fail(e)
  }
  redirect(`/tickets/${number}?flash=${encodeURIComponent(`${number} created`)}`)
}

export async function updateTicketAction(ticketId: string, number: string, version: number, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    const o = formObject(fd)
    const tz = actor.tenant.timezone
    await updateTicket(actor, ticketId, version, {
      subject: o.subject === undefined ? undefined : String(o.subject),
      description: str(o.description, 50_000),
      categoryId: str(o.categoryId),
      impact: (o.impact ?? null) as never,
      urgency: (o.urgency ?? null) as never,
      priority: (o.priority ?? undefined) as never,
      contact: str(o.contact, 200),
      location: str(o.location, 200),
      custom: prefixed(o, "custom"),
      rootCause: str(o.rootCause, 50_000),
      workaround: str(o.workaround, 50_000),
      knownError: "knownError" in o ? bool(o.knownError) : undefined,
      ...("changeType" in o ? changeFields(o, tz) : {}),
    })
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/tickets/${number}`)
  redirect(`/tickets/${number}?flash=${encodeURIComponent("Saved")}`)
}

export async function transitionAction(ticketId: string, number: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    const o = formObject(fd)
    await transitionTicket(actor, ticketId, String(o.action ?? ""), {
      version: o.version ? Number(o.version) : undefined,
      comment: str(o.comment, 5000),
      holdReason: str(o.holdReason, 500),
      holdHours: str(o.holdHours),
      resolutionCode: str(o.resolutionCode, 100),
      resolutionNotes: str(o.resolutionNotes, 50_000),
      rootCause: str(o.rootCause, 50_000),
      workaround: str(o.workaround, 50_000),
      outcome: str(o.outcome),
    })
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/tickets/${number}`)
  return ok("Done")
}

export async function acquireAction(ticketId: string, number: string): Promise<FormState> {
  const actor = await requireActor()
  try {
    await acquireTicket(actor, ticketId)
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/tickets/${number}`)
  return ok("You picked up this ticket")
}

export async function assignAction(ticketId: string, number: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    await assignTicket(actor, ticketId, {
      assigneeId: str(fd.get("assigneeId")),
      groupId: str(fd.get("groupId")),
      note: str(fd.get("note"), 1000),
    })
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/tickets/${number}`)
  return ok("Assignment updated")
}

export async function commentAction(ticketId: string, number: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    await tx(async (db) => {
      await addComment(actor, ticketId, { body: String(fd.get("body") ?? ""), internal: bool(fd.get("internal")) }, db)
      await saveUploads(fd.getAll("files"), { tenantId: actor.tenantId, entityType: "ticket", entityId: ticketId, uploadedBy: actor.id }, db)
    })
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/tickets/${number}`)
  return ok("Sent")
}

export async function uploadAction(ticketId: string, number: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    const { getTicketDetail } = await import("@/lib/itsm/queries")
    const d = await getTicketDetail(actor, number)
    if (!d.access.canCommentPublic && !d.access.canWork) throw new AppError("You cannot add files to this ticket")
    const saved = await saveUploads(fd.getAll("files"), { tenantId: actor.tenantId, entityType: "ticket", entityId: ticketId, uploadedBy: actor.id })
    if (!saved.length) return { error: "Choose a file first" }
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/tickets/${number}`)
  return ok("Uploaded")
}

export async function linkAction(ticketId: string, number: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    await linkTickets(actor, ticketId, String(fd.get("other") ?? ""), String(fd.get("linkType") ?? "related"))
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/tickets/${number}`)
  return ok("Linked")
}

export async function unlinkAction(ticketId: string, number: string, linkId: string): Promise<FormState> {
  const actor = await requireActor()
  try {
    await unlinkTickets(actor, ticketId, linkId)
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/tickets/${number}`)
  return ok("Removed")
}

export async function linkCiAction(ticketId: string, number: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    await linkCi(actor, ticketId, String(fd.get("ciCode") ?? ""), String(fd.get("role") ?? "affected"))
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/tickets/${number}`)
  return ok("Linked")
}

export async function unlinkCiAction(ticketId: string, number: string, ciId: string): Promise<FormState> {
  const actor = await requireActor()
  try {
    await unlinkCi(actor, ticketId, ciId)
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/tickets/${number}`)
  return ok("Removed")
}

export async function watchAction(ticketId: string, number: string, watch: boolean): Promise<FormState> {
  const actor = await requireActor()
  try {
    await setWatching(actor, ticketId, watch)
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/tickets/${number}`)
  return ok(watch ? "You are watching this ticket" : "Stopped watching")
}

export async function addTaskAction(ticketId: string, number: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    await addTask(actor, ticketId, String(fd.get("title") ?? ""), { assigneeId: str(fd.get("assigneeId")) })
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/tickets/${number}`)
  return ok("Task added")
}

export async function taskStatusAction(ticketId: string, number: string, taskId: string, status: "open" | "done" | "cancelled"): Promise<FormState> {
  const actor = await requireActor()
  try {
    await setTaskStatus(actor, ticketId, taskId, status)
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/tickets/${number}`)
  return ok("Updated")
}

export async function deleteTicketAction(ticketId: string): Promise<FormState> {
  const actor = await requireActor()
  try {
    await deleteTicket(actor, ticketId)
  } catch (e) {
    return fail(e)
  }
  redirect("/tickets?flash=" + encodeURIComponent("Ticket deleted"))
}
