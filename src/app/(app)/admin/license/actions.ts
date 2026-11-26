"use server"
import { revalidatePath } from "next/cache"
import { requirePermission } from "@/lib/auth/session"
import { fail, ok, type FormState } from "@/lib/actions"
import { installLicense, removeLicense } from "@/lib/sysadmin/license"

export async function installLicenseAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("admin.license")
  try {
    const licensee = await installLicense(actor, fd.get("license"))
    revalidatePath("/", "layout")
    return ok(`Licence installed for ${licensee}`)
  } catch (e) {
    return fail(e)
  }
}

export async function removeLicenseAction(): Promise<FormState> {
  const actor = await requirePermission("admin.license")
  try {
    await removeLicense(actor)
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/", "layout")
  return ok("Licence removed")
}
