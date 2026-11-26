"use server"
import { revalidatePath } from "next/cache"
import { requirePermission } from "@/lib/auth/session"
import { fail, ok, type FormState } from "@/lib/actions"
import { formObject } from "@/lib/validate"
import { createToken, revokeToken } from "@/lib/sysadmin/api-tokens"

/** The new token comes back once, in the action result; it is never stored in clear. */
export type CreateTokenState = { error?: string; token?: string; at?: number } | null

export async function createTokenAction(_: CreateTokenState, fd: FormData): Promise<CreateTokenState> {
  const actor = await requirePermission("admin.settings")
  try {
    const { token } = await createToken(actor, formObject(fd))
    revalidatePath("/admin/api-tokens")
    return { token, at: Date.now() }
  } catch (e) {
    const r = fail(e)
    return { error: r?.error, at: Date.now() }
  }
}

export async function revokeTokenAction(id: string): Promise<FormState> {
  const actor = await requirePermission("admin.settings")
  try {
    await revokeToken(actor, id)
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/admin/api-tokens")
  return ok("Revoked")
}
