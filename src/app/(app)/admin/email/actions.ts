"use server"
import { revalidatePath } from "next/cache"
import { requirePermission } from "@/lib/auth/session"
import { fail, ok, type FormState } from "@/lib/actions"
import { formObject } from "@/lib/validate"
import { retryOutbox, sendTestMessage, updateMailSettings } from "@/lib/sysadmin/mail"

export async function saveMailAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("admin.settings")
  try {
    await updateMailSettings(actor, formObject(fd))
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/email")
  return ok("Email settings saved")
}

export async function testMailAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("admin.settings")
  try {
    const to = await sendTestMessage(actor, fd.get("to"))
    return ok(`Test email sent to ${to}`)
  } catch (e) {
    return fail(e)
  }
}

export async function retryOutboxAction(outboxId: string): Promise<FormState> {
  const actor = await requirePermission("admin.settings")
  try {
    await retryOutbox(actor, outboxId)
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/email")
  return ok("Queued again")
}
