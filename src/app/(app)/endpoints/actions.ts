"use server"
/** Server actions of the endpoint pages. Each authenticates; the services re-check permissions and the tenant. */
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { requireActor } from "@/lib/auth/session"
import { fail, ok, type FormState } from "@/lib/actions"
import { formObject, int, parseLocalDateTime, str } from "@/lib/validate"
import {
  cancelAgentJob,
  createDeviceGroup,
  createEnrollmentToken,
  deleteDeviceGroup,
  rebootDevice,
  requestDeviceJob,
  retireDevice,
  revokeEnrollmentToken,
  runScript,
  updateDeviceGroup,
  updateDeviceSettings,
} from "@/lib/endpoints/service"
import { installApprovedNow } from "@/lib/endpoints/deployments"
import { REBOOT_BEHAVIORS, SHELLS, isOneOf, type RebootBehavior } from "@/lib/endpoints/vocab"

/* ── enrolment tokens ──────────────────────────────────────────────────── */

/** Returns the new token as the `ok` message (shown once by TokenCreateForm). */
export async function createTokenAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    const o = formObject(fd)
    const maxUses = str(o.maxUses, 20)
    const { token } = await createEnrollmentToken(actor, {
      name: String(o.name ?? ""),
      groupId: str(o.groupId),
      expiresAt: parseLocalDateTime(o.expiresAt, actor.tenant.timezone),
      maxUses: maxUses === null ? null : Number(maxUses),
    })
    revalidatePath("/endpoints/enrol")
    return ok(token)
  } catch (e) {
    return fail(e)
  }
}

export async function revokeTokenAction(tokenId: string, _: FormState, __: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    await revokeEnrollmentToken(actor, tokenId)
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/endpoints/enrol")
  return ok("Revoked")
}

/* ── device groups ─────────────────────────────────────────────────────── */

function groupInput(fd: FormData) {
  const o = formObject(fd)
  return { name: String(o.name ?? ""), description: str(o.description, 1000), ring: int(o.ring, 1, 0, 9) }
}

export async function createGroupAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    await createDeviceGroup(actor, groupInput(fd))
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/endpoints/groups")
  return ok("Group created")
}

export async function updateGroupAction(groupId: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    await updateDeviceGroup(actor, groupId, groupInput(fd))
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/endpoints/groups")
  return ok("Saved")
}

export async function deleteGroupAction(groupId: string, _: FormState, __: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    await deleteDeviceGroup(actor, groupId)
  } catch (e) {
    return fail(e)
  }
  redirect("/endpoints/groups?flash=" + encodeURIComponent("Group deleted"))
}

/* ── device actions ────────────────────────────────────────────────────── */

export async function deviceJobAction(deviceId: string, kind: "inventory" | "scan", _: FormState, __: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    await requestDeviceJob(actor, deviceId, kind === "scan" ? "scan" : "inventory")
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/endpoints/${deviceId}`)
  return ok(kind === "scan" ? "Patch scan requested. The agent picks it up on its next poll." : "Inventory requested. The agent picks it up on its next poll.")
}

export async function installNowAction(deviceId: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    const reboot = String(fd.get("reboot") ?? "if_required")
    const r = await installApprovedNow(actor, deviceId, (isOneOf(REBOOT_BEHAVIORS, reboot) ? reboot : "if_required") as RebootBehavior)
    revalidatePath(`/endpoints/${deviceId}`)
    return ok(`Queued installation of ${r.patches} approved patch${r.patches === 1 ? "" : "es"}`)
  } catch (e) {
    return fail(e)
  }
}

export async function rebootAction(deviceId: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    const o = formObject(fd)
    await rebootDevice(actor, deviceId, { delaySeconds: int(o.delaySeconds, 60, 0, 86_400), message: str(o.message, 500) })
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/endpoints/${deviceId}`)
  return ok("Reboot requested")
}

export async function deviceSettingsAction(deviceId: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    const o = formObject(fd)
    const tags = String(o.tags ?? "")
      .split(/[,\n]+/)
      .map((t) => t.trim())
      .filter(Boolean)
    await updateDeviceSettings(actor, deviceId, { groupId: str(o.groupId), tags })
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/endpoints/${deviceId}`)
  return ok("Saved")
}

export async function retireAction(deviceId: string, _: FormState, __: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    await retireDevice(actor, deviceId)
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/endpoints/${deviceId}`)
  redirect(`/endpoints/${deviceId}?flash=${encodeURIComponent("Device retired. Its agent can no longer connect.")}`)
}

export async function runScriptAction(deviceId: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    const shell = String(fd.get("shell") ?? "")
    if (!isOneOf(SHELLS, shell)) return { error: "Choose a shell", at: Date.now() }
    await runScript(actor, deviceId, {
      shell,
      script: String(fd.get("script") ?? ""),
      timeoutSeconds: int(fd.get("timeoutSeconds"), 300, 10, 3600),
    })
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/endpoints/${deviceId}`)
  redirect(`/endpoints/${deviceId}?tab=jobs&flash=${encodeURIComponent("Script queued. Its output appears here when the agent reports back.")}`)
}

export async function cancelJobAction(deviceId: string, jobId: string, _: FormState, __: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    await cancelAgentJob(actor, jobId)
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/endpoints/${deviceId}`)
  return ok("Cancelled")
}
