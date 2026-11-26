"use server"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { requirePermission } from "@/lib/auth/session"
import { fail, ok, type FormState } from "@/lib/actions"
import { formObject } from "@/lib/validate"
import { deleteProvider, saveProvider, testLdapProvider, type ProviderKind } from "@/lib/sysadmin/auth-providers"

export async function saveProviderAction(id: string | null, kind: ProviderKind, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("admin.settings")
  let saved: string
  try {
    saved = await saveProvider(actor, id, kind, formObject(fd))
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/auth")
  redirect(`/admin/auth/${saved}?flash=${encodeURIComponent(id ? "Saved" : "Sign-in provider added")}`)
}

export async function deleteProviderAction(id: string): Promise<FormState> {
  const actor = await requirePermission("admin.settings")
  try {
    await deleteProvider(actor, id)
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/auth")
  redirect("/admin/auth?flash=" + encodeURIComponent("Sign-in provider removed"))
}

export async function testLdapAction(id: string): Promise<FormState> {
  const actor = await requirePermission("admin.settings")
  try {
    return ok(await testLdapProvider(actor, id))
  } catch (e) {
    return fail(e)
  }
}
