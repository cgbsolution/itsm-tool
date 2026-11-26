"use server"
import { redirect } from "next/navigation"
import { requireActor } from "@/lib/auth/session"
import { tx } from "@/lib/db"
import { fail, type FormState } from "@/lib/actions"
import { saveUploads } from "@/lib/files/storage"
import { submitRequest } from "@/lib/catalog/service"

/** Submits a catalog request. Answers arrive as "f.<key>" fields (repeated for multi-select). */
export async function submitRequestAction(itemId: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  let number: string
  try {
    const answers = new Map<string, string[]>()
    for (const [k, v] of fd.entries()) {
      if (!k.startsWith("f.") || typeof v !== "string") continue
      const key = k.slice(2)
      answers.set(key, [...(answers.get(key) ?? []), v])
    }
    const ticket = await tx(async (db) => {
      const t = await submitRequest(actor, itemId, Object.fromEntries(answers), db)
      await saveUploads(fd.getAll("files"), { tenantId: actor.tenantId, entityType: "ticket", entityId: t.id, uploadedBy: actor.id }, db)
      return t
    })
    number = ticket.number
  } catch (e) {
    return fail(e)
  }
  redirect(`/tickets/${number}?flash=${encodeURIComponent(`Request ${number} submitted`)}`)
}
