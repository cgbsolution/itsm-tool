"use server"
/** Knowledge base server actions. Each one authenticates; the service re-checks permissions. */
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { requireActor, requirePermission } from "@/lib/auth/session"
import { tx } from "@/lib/db"
import { fail, ok, type FormState } from "@/lib/actions"
import { int, str } from "@/lib/validate"
import {
  addArticleFiles,
  createArticle,
  createKbCategory,
  deleteArticleFile,
  deleteKbCategory,
  linkArticleToTicket,
  parseTags,
  setArticleStatus,
  unlinkArticleFromTicket,
  updateArticle,
  updateKbCategory,
  voteArticle,
  type ArticleInput,
} from "@/lib/kb/service"

function articleInput(fd: FormData): ArticleInput {
  return {
    title: String(fd.get("title") ?? ""),
    summary: String(fd.get("summary") ?? "").trim() || null,
    body: String(fd.get("body") ?? ""),
    categoryId: str(fd.get("categoryId")),
    tags: parseTags(String(fd.get("tags") ?? "")),
    visibility: String(fd.get("visibility") ?? "internal") as ArticleInput["visibility"],
  }
}

export async function createArticleAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("kb.write")
  let id: string
  let number: string
  try {
    const a = await tx(async (db) => {
      const created = await createArticle(actor, articleInput(fd), db)
      await addArticleFiles(actor, created.id, fd.getAll("files"), db)
      return created
    })
    id = a.id
    number = a.number
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/kb")
  redirect(`/kb/${id}?flash=${encodeURIComponent(`${number} saved as a draft`)}`)
}

export async function updateArticleAction(id: string, version: number, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("kb.write")
  try {
    await updateArticle(actor, id, version, articleInput(fd))
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/kb/${id}`)
  revalidatePath("/kb")
  redirect(`/kb/${id}?flash=${encodeURIComponent("Saved")}`)
}

export async function articleStatusAction(id: string, action: string): Promise<FormState> {
  const actor = await requireActor()
  let label = "Updated"
  try {
    const a = await setArticleStatus(actor, id, action)
    label = { draft: "Moved back to draft", review: "Submitted for review", published: "Published", retired: "Retired" }[a.status]
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/kb/${id}`)
  revalidatePath("/kb")
  return ok(label)
}

export async function voteAction(id: string, helpful: boolean): Promise<FormState> {
  const actor = await requireActor()
  try {
    await voteArticle(actor, id, helpful)
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/kb/${id}`)
  return ok("Thanks for your feedback")
}

export async function linkTicketAction(id: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  let number: string
  try {
    number = (await linkArticleToTicket(actor, id, String(fd.get("ticket") ?? ""))).number
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/kb/${id}`)
  return ok(`Linked to ${number}`)
}

export async function unlinkTicketAction(id: string, ticketId: string): Promise<FormState> {
  const actor = await requireActor()
  try {
    await unlinkArticleFromTicket(actor, id, ticketId)
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/kb/${id}`)
  return ok("Link removed")
}

export async function uploadArticleFilesAction(id: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("kb.write")
  let count = 0
  try {
    count = (await addArticleFiles(actor, id, fd.getAll("files"))).length
    if (!count) return { error: "Choose a file first" }
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/kb/${id}/edit`)
  revalidatePath(`/kb/${id}`)
  return ok(count === 1 ? "File uploaded" : `${count} files uploaded`)
}

export async function deleteArticleFileAction(id: string, fileId: string): Promise<FormState> {
  const actor = await requirePermission("kb.write")
  try {
    await deleteArticleFile(actor, id, fileId)
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/kb/${id}/edit`)
  revalidatePath(`/kb/${id}`)
  return ok("File removed")
}

/* ── categories ────────────────────────────────────────────────────────── */

export async function createKbCategoryAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("kb.publish")
  try {
    await createKbCategory(actor, { name: String(fd.get("name") ?? ""), sortOrder: int(fd.get("sortOrder"), 0, -10_000, 10_000) })
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/kb/categories")
  return ok("Category added")
}

export async function updateKbCategoryAction(categoryId: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("kb.publish")
  try {
    await updateKbCategory(actor, categoryId, { name: String(fd.get("name") ?? ""), sortOrder: int(fd.get("sortOrder"), 0, -10_000, 10_000) })
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/kb/categories")
  return ok("Saved")
}

export async function deleteKbCategoryAction(categoryId: string): Promise<FormState> {
  const actor = await requirePermission("kb.publish")
  try {
    await deleteKbCategory(actor, categoryId)
  } catch (e) {
    return fail(e)
  }
  redirect("/kb/categories?flash=" + encodeURIComponent("Category deleted"))
}
