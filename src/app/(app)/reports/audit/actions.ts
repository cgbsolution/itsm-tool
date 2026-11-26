"use server"
import { requirePermission } from "@/lib/auth/session"
import { fail, ok, type FormState } from "@/lib/actions"
import { verifyAudit } from "@/lib/reports/audit"

export async function verifyAuditAction(): Promise<FormState> {
  const actor = await requirePermission("audit.view")
  try {
    const r = await verifyAudit(actor)
    if (r.brokenAt !== null) return { error: `Integrity check FAILED: the chain is broken at entry #${r.brokenAt} (${r.checked} entries checked). Entries may have been altered.`, at: Date.now() }
    return ok(`Integrity verified: all ${r.checked} entries are intact and correctly chained.`)
  } catch (e) {
    return fail(e)
  }
}
