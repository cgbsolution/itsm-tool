"use server"
/** Server actions of the patch pages. Each authenticates; the services re-check permissions and the tenant. */
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { requireActor } from "@/lib/auth/session"
import { fail, ok, type FormState } from "@/lib/actions"
import { bool, formObject, int, parseLocalDateTime, str } from "@/lib/validate"
import { AppError } from "@/lib/errors"
import { createPolicy, deletePolicy, removePatchPackage, setPatchApproval, updatePolicy, type PolicyInput } from "@/lib/endpoints/service"
import { cancelDeployment, createDeployment } from "@/lib/endpoints/deployments"
import { APPROVALS, CLASSIFICATIONS, REBOOT_BEHAVIORS, isOneOf, type Approval, type RebootBehavior } from "@/lib/endpoints/vocab"

const list = (v: FormDataEntryValue[]) => v.map((x) => String(x)).filter(Boolean)

/* ── approval ──────────────────────────────────────────────────────────── */

export async function bulkApprovalAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    const decision = String(fd.get("decision") ?? "")
    if (!isOneOf(APPROVALS, decision)) throw new AppError("Choose approve or decline")
    const ids = list(fd.getAll("ids"))
    const n = await setPatchApproval(actor, ids, decision as Approval)
    revalidatePath("/patches")
    return ok(`${n} patch${n === 1 ? "" : "es"} ${decision === "approved" ? "approved" : decision === "declined" ? "declined" : "reset to pending"}${n < ids.length ? ` (${ids.length - n} already were)` : ""}`)
  } catch (e) {
    return fail(e)
  }
}

export async function patchApprovalAction(patchId: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    const decision = String(fd.get("decision") ?? "")
    if (!isOneOf(APPROVALS, decision)) throw new AppError("Choose approve or decline")
    await setPatchApproval(actor, [patchId], decision as Approval)
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/patches/${patchId}`)
  return ok("Saved")
}

export async function removePackageAction(patchId: string, _: FormState, __: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    await removePatchPackage(actor, patchId)
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/patches/${patchId}`)
  return ok("Package removed")
}

/* ── deployments ───────────────────────────────────────────────────────── */

export async function createDeploymentAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  let id: string
  let message: string
  try {
    const o = formObject(fd)
    const schedule = String(o.schedule ?? "now")
    const reboot = String(o.rebootBehavior ?? "if_required")
    const r = await createDeployment(actor, {
      name: String(o.name ?? ""),
      description: str(o.description, 5000),
      patchIds: list(fd.getAll("patchIds")),
      targetGroupIds: list(fd.getAll("targetGroupIds")),
      targetDeviceIds: list(fd.getAll("targetDeviceIds")),
      schedule: (["now", "at", "window"].includes(schedule) ? schedule : "now") as "now" | "at" | "window",
      scheduledAt: schedule === "at" ? parseLocalDateTime(o.scheduledAt, actor.tenant.timezone) : null,
      maintenanceWindowId: schedule === "window" ? str(o.maintenanceWindowId) : null,
      rebootBehavior: (isOneOf(REBOOT_BEHAVIORS, reboot) ? reboot : "if_required") as RebootBehavior,
      changeNumber: str(o.changeNumber, 40),
    })
    id = r.id
    message = r.status === "running" ? `Deployment started: ${r.jobs} device job${r.jobs === 1 ? "" : "s"} queued` : r.status === "completed" ? "No target device is missing these patches; nothing to do" : "Deployment scheduled"
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/patches/deployments")
  redirect(`/patches/deployments/${id}?flash=${encodeURIComponent(message)}`)
}

export async function cancelDeploymentAction(deploymentId: string, _: FormState, __: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    const r = await cancelDeployment(actor, deploymentId)
    revalidatePath(`/patches/deployments/${deploymentId}`)
    return ok(`Cancelled. ${r.cancelledJobs} job${r.cancelledJobs === 1 ? "" : "s"} that had not started were cancelled.`)
  } catch (e) {
    return fail(e)
  }
}

/* ── policies ──────────────────────────────────────────────────────────── */

function policyInput(fd: FormData): PolicyInput {
  const o = formObject(fd)
  const reboot = String(o.rebootBehavior ?? "if_required")
  return {
    name: String(o.name ?? ""),
    description: str(o.description, 2000),
    deviceGroupId: str(o.deviceGroupId),
    autoApproveClassifications: list(fd.getAll("autoApproveClassifications")).filter((c): c is (typeof CLASSIFICATIONS)[number] => isOneOf(CLASSIFICATIONS, c)),
    autoApproveDelayDays: int(o.autoApproveDelayDays, 0, 0, 365),
    scheduleDays: list(fd.getAll("scheduleDays")).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
    scheduleTime: String(o.scheduleTime ?? "02:00"),
    maintenanceWindowId: str(o.maintenanceWindowId),
    rebootBehavior: (isOneOf(REBOOT_BEHAVIORS, reboot) ? reboot : "if_required") as RebootBehavior,
    isActive: bool(o.isActive),
  }
}

export async function createPolicyAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    await createPolicy(actor, policyInput(fd))
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/patches/policies")
  redirect("/patches/policies?flash=" + encodeURIComponent("Policy created"))
}

export async function updatePolicyAction(policyId: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    await updatePolicy(actor, policyId, policyInput(fd))
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/patches/policies")
  redirect("/patches/policies?flash=" + encodeURIComponent("Policy saved"))
}

export async function deletePolicyAction(policyId: string, _: FormState, __: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    await deletePolicy(actor, policyId)
  } catch (e) {
    return fail(e)
  }
  redirect("/patches/policies?flash=" + encodeURIComponent("Policy deleted"))
}
