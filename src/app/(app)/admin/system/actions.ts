"use server"
import { revalidatePath } from "next/cache"
import { requirePermission } from "@/lib/auth/session"
import { fail, ok, type FormState } from "@/lib/actions"
import { retryDeadJob } from "@/lib/sysadmin/system"

export async function retryJobAction(jobId: number): Promise<FormState> {
  const actor = await requirePermission("admin.settings")
  try {
    await retryDeadJob(actor, Number(jobId))
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/system")
  return ok("Queued again")
}
