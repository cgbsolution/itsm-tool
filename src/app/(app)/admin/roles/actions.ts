"use server"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { requirePermission } from "@/lib/auth/session"
import { fail, ok, type FormState } from "@/lib/actions"
import { createCustomRole, deleteCustomRole, updateCustomRole } from "@/lib/admin/roles"

export async function createRoleAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("admin.users")
  let id: string
  try {
    id = await createCustomRole(actor, { key: fd.get("key"), name: fd.get("name"), description: fd.get("description"), permissions: fd.getAll("permissions") })
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/roles")
  redirect(`/admin/roles/${id}?flash=${encodeURIComponent("Role created. Assign it to people on their user page.")}`)
}

export async function updateRoleAction(roleId: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("admin.users")
  try {
    await updateCustomRole(actor, roleId, { name: fd.get("name"), description: fd.get("description"), permissions: fd.getAll("permissions") })
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/admin/roles/${roleId}`)
  revalidatePath("/admin/roles")
  return ok("Saved. People with this role get the new permissions on their next page load.")
}

export async function deleteRoleAction(roleId: string): Promise<FormState> {
  const actor = await requirePermission("admin.users")
  try {
    await deleteCustomRole(actor, roleId)
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/roles")
  redirect("/admin/roles?flash=" + encodeURIComponent("Role deleted"))
}
