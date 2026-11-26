"use server"
import { revalidatePath } from "next/cache"
import { requirePermission } from "@/lib/auth/session"
import { fail, ok, type FormState } from "@/lib/actions"
import { formObject } from "@/lib/validate"
import { updateGeneralSettings } from "@/lib/sysadmin/settings"

export async function saveSettingsAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("admin.settings")
  try {
    await updateGeneralSettings(actor, formObject(fd))
  } catch (e) {
    return fail(e)
  }
  // brand colour and name are shown by the app layout
  revalidatePath("/", "layout")
  return ok("Settings saved")
}
