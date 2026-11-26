"use server"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { requirePermission } from "@/lib/auth/session"
import { fail, ok, type FormState } from "@/lib/actions"
import { formObject } from "@/lib/validate"
import { addGroupMember, createGroup, deleteGroup, removeGroupMember, updateGroup, type GroupInput } from "@/lib/admin/groups"

function input(fd: FormData): GroupInput {
  const o = formObject(fd)
  return { name: o.name, description: o.description, email: o.email, kind: o.kind, managerId: o.managerId, isActive: o.isActive ?? "" }
}

export async function createGroupAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("admin.users")
  let id: string
  try {
    id = await createGroup(actor, input(fd))
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/groups")
  redirect(`/admin/groups/${id}?flash=${encodeURIComponent("Group created. Add its members below.")}`)
}

export async function updateGroupAction(groupId: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("admin.users")
  try {
    await updateGroup(actor, groupId, input(fd))
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/admin/groups/${groupId}`)
  revalidatePath("/admin/groups")
  return ok("Saved")
}

export async function deleteGroupAction(groupId: string): Promise<FormState> {
  const actor = await requirePermission("admin.users")
  try {
    await deleteGroup(actor, groupId)
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/groups")
  redirect("/admin/groups?flash=" + encodeURIComponent("Group deleted"))
}

export async function addMemberAction(groupId: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("admin.users")
  try {
    const added = await addGroupMember(actor, groupId, String(fd.get("userId") ?? ""))
    revalidatePath(`/admin/groups/${groupId}`)
    return ok(added ? "Member added" : "Already a member")
  } catch (e) {
    return fail(e)
  }
}

export async function removeMemberAction(groupId: string, userId: string): Promise<FormState> {
  const actor = await requirePermission("admin.users")
  try {
    await removeGroupMember(actor, groupId, userId)
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/admin/groups/${groupId}`)
  return ok("Member removed")
}
