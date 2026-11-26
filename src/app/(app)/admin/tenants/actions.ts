"use server"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { requirePermission } from "@/lib/auth/session"
import { fail, ok, type FormState } from "@/lib/actions"
import { formObject } from "@/lib/validate"
import { createTenantWithAdmin, setTenantStatus, switchBack, switchTenant } from "@/lib/sysadmin/tenants"

export async function createTenantAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("admin.tenants")
  try {
    const { slug } = await createTenantWithAdmin(actor, formObject(fd))
    revalidatePath("/admin/tenants")
    return ok(`Tenant created (${slug}). The administrator has been sent an invitation valid for 72 hours.`)
  } catch (e) {
    return fail(e)
  }
}

export async function setTenantStatusAction(tenantId: string, status: "active" | "suspended"): Promise<FormState> {
  const actor = await requirePermission("admin.tenants")
  try {
    await setTenantStatus(actor, tenantId, status)
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/tenants")
  return ok(status === "suspended" ? "Suspended" : "Activated")
}

export async function switchTenantAction(tenantId: string): Promise<FormState> {
  const actor = await requirePermission("admin.tenants")
  let name: string
  try {
    name = await switchTenant(actor, tenantId)
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/", "layout")
  redirect("/?flash=" + encodeURIComponent(`You are now working in ${name}`))
}

export async function switchBackAction(): Promise<FormState> {
  const actor = await requirePermission("admin.tenants")
  try {
    await switchBack(actor)
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/", "layout")
  redirect("/admin/tenants?flash=" + encodeURIComponent("Back in your own tenant"))
}
