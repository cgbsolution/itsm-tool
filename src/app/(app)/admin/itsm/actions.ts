"use server"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { requirePermission } from "@/lib/auth/session"
import { fail, ok, type FormState } from "@/lib/actions"
import { formObject } from "@/lib/validate"
import { createCategory, deleteCategory, saveCalendar, saveMatrix, updateCategory } from "@/lib/admin/itsm"
import { createSlaPolicy, deleteSlaPolicy, updateSlaPolicy, type SlaInput } from "@/lib/admin/sla"
import { createCustomField, deleteCustomField, updateCustomField, type FieldInput } from "@/lib/admin/fields"
import { resetTemplate, saveTemplate } from "@/lib/admin/templates"
import { createWindow, deleteWindow, updateWindow, type WindowInput } from "@/lib/admin/windows"

const PERM = "admin.itsm" as const

/* ── categories ────────────────────────────────────────────────────────── */

export async function createCategoryAction(parentId: string | null, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    await createCategory(actor, { name: fd.get("name"), parentId, ticketTypes: fd.getAll("ticketTypes"), sortOrder: fd.get("sortOrder") })
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/itsm/categories")
  return ok(parentId ? "Sub-category added" : "Category added")
}

export async function updateCategoryAction(id: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    await updateCategory(actor, id, { name: fd.get("name"), ticketTypes: fd.getAll("ticketTypes"), sortOrder: fd.get("sortOrder"), isActive: fd.get("isActive") })
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/itsm/categories")
  return ok("Saved")
}

export async function deleteCategoryAction(id: string): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    await deleteCategory(actor, id)
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/itsm/categories")
  return ok("Deleted")
}

/* ── priority matrix ───────────────────────────────────────────────────── */

export async function saveMatrixAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    const n = await saveMatrix(actor, formObject(fd))
    revalidatePath("/admin/itsm/priority")
    return ok(n ? `Saved (${n} cell${n === 1 ? "" : "s"} changed). New and re-prioritised tickets use it.` : "No change")
  } catch (e) {
    return fail(e)
  }
}

/* ── SLA / OLA ─────────────────────────────────────────────────────────── */

function slaInput(fd: FormData): SlaInput {
  const o = formObject(fd)
  return {
    kind: o.kind,
    ticketType: o.ticketType,
    priority: o.priority,
    groupId: o.groupId,
    responseHours: o.responseHours,
    responseMinutes: o.responseMinutes,
    resolutionHours: o.resolutionHours,
    resolutionMinutes: o.resolutionMinutes,
    businessHours: o.businessHours ?? "",
    warnPercent: o.warnPercent,
    isActive: o.isActive ?? "",
  }
}

export async function createSlaAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    await createSlaPolicy(actor, slaInput(fd))
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/itsm/sla")
  return ok("Policy added")
}

export async function updateSlaAction(id: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    await updateSlaPolicy(actor, id, slaInput(fd))
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/itsm/sla")
  redirect("/admin/itsm/sla?flash=" + encodeURIComponent("Policy saved. It applies to clocks that start from now on."))
}

export async function deleteSlaAction(id: string): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    await deleteSlaPolicy(actor, id)
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/itsm/sla")
  redirect("/admin/itsm/sla?flash=" + encodeURIComponent("Policy deleted"))
}

/* ── calendar ──────────────────────────────────────────────────────────── */

export async function saveCalendarAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    const changed = await saveCalendar(actor, {
      timezone: fd.get("timezone"),
      workDays: fd.getAll("workDays"),
      workStart: fd.get("workStart"),
      workEnd: fd.get("workEnd"),
      holidays: fd.get("holidays"),
      holdMaxHours: fd.get("holdMaxHours"),
      reopenWindowDays: fd.get("reopenWindowDays"),
      autoCloseResolvedDays: fd.get("autoCloseResolvedDays"),
      strictAssignment: fd.get("strictAssignment"),
    })
    revalidatePath("/admin/itsm/calendar")
    return ok(changed.length ? "Saved. Business-hours clocks that start from now on use the new calendar." : "No change")
  } catch (e) {
    return fail(e)
  }
}

/* ── custom fields ─────────────────────────────────────────────────────── */

function fieldInput(fd: FormData): FieldInput {
  const o = formObject(fd)
  return {
    key: o.key,
    label: o.label,
    fieldType: o.fieldType,
    options: fd.get("options"),
    required: o.required ?? "",
    ticketTypes: fd.getAll("ticketTypes"),
    helpText: o.helpText,
    sortOrder: o.sortOrder,
    isActive: o.isActive ?? "",
  }
}

export async function createFieldAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    await createCustomField(actor, fieldInput(fd))
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/itsm/fields")
  redirect("/admin/itsm/fields?flash=" + encodeURIComponent("Field added"))
}

export async function updateFieldAction(id: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    await updateCustomField(actor, id, fieldInput(fd))
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/itsm/fields")
  redirect("/admin/itsm/fields?flash=" + encodeURIComponent("Field saved"))
}

export async function deleteFieldAction(id: string): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    await deleteCustomField(actor, id)
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/itsm/fields")
  redirect("/admin/itsm/fields?flash=" + encodeURIComponent("Field deleted"))
}

/* ── email templates ───────────────────────────────────────────────────── */

export async function saveTemplateAction(key: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    await saveTemplate(actor, key, { subject: fd.get("subject"), body: fd.get("body") })
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/itsm/templates")
  revalidatePath(`/admin/itsm/templates/${key}`)
  return ok("Saved. New emails use this text.")
}

export async function resetTemplateAction(key: string): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    await resetTemplate(actor, key)
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/itsm/templates")
  redirect(`/admin/itsm/templates/${encodeURIComponent(key)}?flash=${encodeURIComponent("Reset to the default text")}`)
}

/* ── maintenance windows ───────────────────────────────────────────────── */

function windowInput(fd: FormData): WindowInput {
  const o = formObject(fd)
  return {
    name: o.name,
    description: o.description,
    kind: o.kind,
    appliesTo: o.appliesTo,
    startsAt: o.startsAt,
    endsAt: o.endsAt,
    recurrence: o.recurrence,
    recurrenceUntil: o.recurrenceUntil,
    isActive: o.isActive ?? "",
  }
}

export async function createWindowAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    await createWindow(actor, windowInput(fd))
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/itsm/windows")
  redirect("/admin/itsm/windows?flash=" + encodeURIComponent("Window added"))
}

export async function updateWindowAction(id: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    await updateWindow(actor, id, windowInput(fd))
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/itsm/windows")
  redirect("/admin/itsm/windows?flash=" + encodeURIComponent("Window saved"))
}

export async function deleteWindowAction(id: string): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    await deleteWindow(actor, id)
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/itsm/windows")
  redirect("/admin/itsm/windows?flash=" + encodeURIComponent("Window deleted"))
}
