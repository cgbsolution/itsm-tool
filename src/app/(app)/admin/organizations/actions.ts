"use server"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { requirePermission } from "@/lib/auth/session"
import { fail, ok, type FormState } from "@/lib/actions"
import { createOrganization, deleteOrganization, updateOrganization } from "@/lib/admin/organizations"

export async function createOrganizationAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("admin.users")
  try {
    await createOrganization(actor, { name: fd.get("name"), domain: fd.get("domain"), status: fd.get("status") })
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/organizations")
  return ok("Organisation added")
}

export async function updateOrganizationAction(id: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("admin.users")
  try {
    await updateOrganization(actor, id, { name: fd.get("name"), domain: fd.get("domain"), status: fd.get("status") })
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/organizations")
  revalidatePath(`/admin/organizations/${id}`)
  return ok("Saved")
}

export async function deleteOrganizationAction(id: string): Promise<FormState> {
  const actor = await requirePermission("admin.users")
  try {
    await deleteOrganization(actor, id)
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/organizations")
  redirect("/admin/organizations?flash=" + encodeURIComponent("Organisation deleted"))
}
