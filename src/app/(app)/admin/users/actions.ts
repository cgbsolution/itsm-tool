"use server"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { requirePermission } from "@/lib/auth/session"
import { fail, ok, type FormState } from "@/lib/actions"
import { formObject } from "@/lib/validate"
import { list } from "@/lib/admin/rules"
import {
  createUser,
  resetUserMfa,
  sendPasswordLink,
  setUserEnabled,
  setUserGroups,
  setUserRole,
  signOutEverywhere,
  unlockUser,
  updateUserDetails,
} from "@/lib/admin/users"

export async function createUserAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("admin.users")
  let target: string
  try {
    const o = formObject(fd)
    const r = await createUser(actor, {
      email: o.email,
      fullName: o.fullName,
      role: o.role,
      department: o.department,
      designation: o.designation,
      phone: o.phone,
      managerId: o.managerId,
      organizationId: o.organizationId,
      mode: o.mode,
      password: fd.get("password"),
    })
    target = `/admin/users/${r.id}?flash=${encodeURIComponent(r.invited ? "User created and invitation sent" : "User created. They must change the temporary password at first sign-in.")}`
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/users")
  redirect(target)
}

export async function updateUserAction(userId: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("admin.users")
  try {
    const o = formObject(fd)
    await updateUserDetails(actor, userId, {
      fullName: o.fullName,
      email: o.email,
      department: o.department,
      designation: o.designation,
      phone: o.phone,
      employeeId: o.employeeId,
      location: o.location,
      managerId: o.managerId,
      organizationId: o.organizationId,
    })
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/admin/users/${userId}`)
  return ok("Saved")
}

export async function setRoleAction(userId: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("admin.users")
  try {
    const changed = await setUserRole(actor, userId, fd.get("role"))
    revalidatePath(`/admin/users/${userId}`)
    return ok(changed ? "Role changed. The person was signed out everywhere." : "No change")
  } catch (e) {
    return fail(e)
  }
}

export async function setGroupsAction(userId: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("admin.users")
  try {
    const r = await setUserGroups(actor, userId, list(fd.getAll("groups")))
    revalidatePath(`/admin/users/${userId}`)
    return ok(r.added || r.removed ? `Groups saved (${r.added} added, ${r.removed} removed)` : "No change")
  } catch (e) {
    return fail(e)
  }
}

export async function setEnabledAction(userId: string, enabled: boolean): Promise<FormState> {
  const actor = await requirePermission("admin.users")
  try {
    await setUserEnabled(actor, userId, enabled)
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/admin/users/${userId}`)
  revalidatePath("/admin/users")
  return ok(enabled ? "Account enabled" : "Account disabled and signed out everywhere")
}

export async function sendPasswordLinkAction(userId: string): Promise<FormState> {
  const actor = await requirePermission("admin.users")
  try {
    const { purpose, link } = await sendPasswordLink(actor, userId)
    if (link) {
      return ok(`Email is not configured, so nothing was sent. Give this one-time link to the person yourself (valid for ${purpose === "invite" ? "72" : "2"} hours): ${link}`)
    }
    return ok(purpose === "invite" ? "A new invitation is on its way" : "A password reset link is on its way")
  } catch (e) {
    return fail(e)
  }
}

export async function resetMfaAction(userId: string): Promise<FormState> {
  const actor = await requirePermission("admin.users")
  try {
    const changed = await resetUserMfa(actor, userId)
    revalidatePath(`/admin/users/${userId}`)
    return ok(changed ? "Two-step sign-in reset. They will set it up again if your policy requires it." : "Two-step sign-in was not set up")
  } catch (e) {
    return fail(e)
  }
}

export async function unlockAction(userId: string): Promise<FormState> {
  const actor = await requirePermission("admin.users")
  try {
    const changed = await unlockUser(actor, userId)
    revalidatePath(`/admin/users/${userId}`)
    return ok(changed ? "Unlocked" : "The account was not locked")
  } catch (e) {
    return fail(e)
  }
}

export async function signOutEverywhereAction(userId: string): Promise<FormState> {
  const actor = await requirePermission("admin.users")
  try {
    const n = await signOutEverywhere(actor, userId)
    revalidatePath(`/admin/users/${userId}`)
    return ok(`Signed out of ${n} session${n === 1 ? "" : "s"}`)
  } catch (e) {
    return fail(e)
  }
}
