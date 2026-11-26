/**
 * Helpers for server actions used with <ActionForm>.
 *   export async function doThing(prev: FormState, fd: FormData): Promise<FormState> {
 *     const actor = await requireActor()
 *     try { ... } catch (e) { return fail(e) }
 *     redirect("/somewhere")            // outside try, or rethrown by fail()
 *   }
 */
import { unstable_rethrow } from "next/navigation"
import { AppError, userMessage } from "@/lib/errors"
import { log } from "@/lib/log"

export type FormState = { error?: string; ok?: string; at?: number } | null

export function fail(err: unknown): FormState {
  unstable_rethrow(err)
  if (!(err instanceof AppError)) log.error("action.failed", { err })
  return { error: userMessage(err), at: Date.now() }
}

export function ok(message: string): FormState {
  return { ok: message, at: Date.now() }
}
