"use server"
/** Catalog administration actions (catalog.manage). The service re-checks the permission and audits each change. */
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { requirePermission } from "@/lib/auth/session"
import { fail, ok, type FormState } from "@/lib/actions"
import { bool, int, str } from "@/lib/validate"
import type { FieldRowInput } from "@/lib/catalog/forms"
import {
  createCatalogCategory,
  createCatalogItem,
  createStarterItems,
  deleteCatalogCategory,
  deleteCatalogItem,
  setCatalogItemForm,
  setCatalogItemTasks,
  updateCatalogCategory,
  updateCatalogItem,
  type CatalogCategoryInput,
  type CatalogItemInput,
} from "@/lib/catalog/service"

const PERM = "catalog.manage" as const

function refresh(itemId?: string) {
  revalidatePath("/catalog")
  revalidatePath("/catalog/manage")
  if (itemId) {
    revalidatePath(`/catalog/manage/items/${itemId}`)
    revalidatePath(`/catalog/${itemId}`)
  }
}

function categoryInput(fd: FormData): CatalogCategoryInput {
  return {
    name: String(fd.get("name") ?? ""),
    description: String(fd.get("description") ?? "").trim() || null,
    sortOrder: int(fd.get("sortOrder"), 0, -10_000, 10_000),
    isActive: bool(fd.get("isActive")),
  }
}

function itemInput(fd: FormData): CatalogItemInput {
  return {
    name: String(fd.get("name") ?? ""),
    categoryId: str(fd.get("categoryId")),
    shortDescription: String(fd.get("shortDescription") ?? "").trim() || null,
    description: String(fd.get("description") ?? "") || null,
    isActive: bool(fd.get("isActive")),
    sortOrder: int(fd.get("sortOrder"), 0, -10_000, 10_000),
    visibility: String(fd.get("visibility") ?? "all") as CatalogItemInput["visibility"],
    defaultPriority: String(fd.get("defaultPriority") ?? "medium") as CatalogItemInput["defaultPriority"],
    ticketCategoryId: str(fd.get("ticketCategoryId")),
    fulfilmentGroupId: str(fd.get("fulfilmentGroupId")),
    requiresApproval: bool(fd.get("requiresApproval")),
    approvalMode: String(fd.get("approvalMode") ?? "any") as CatalogItemInput["approvalMode"],
    approverGroupId: str(fd.get("approverGroupId")),
    approveByManager: bool(fd.get("approveByManager")),
  }
}

/* ── categories ────────────────────────────────────────────────────────── */

export async function createCatalogCategoryAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    await createCatalogCategory(actor, categoryInput(fd))
  } catch (e) {
    return fail(e)
  }
  refresh()
  return ok("Category added")
}

export async function updateCatalogCategoryAction(id: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    await updateCatalogCategory(actor, id, categoryInput(fd))
  } catch (e) {
    return fail(e)
  }
  refresh()
  return ok("Saved")
}

export async function deleteCatalogCategoryAction(id: string): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    await deleteCatalogCategory(actor, id)
  } catch (e) {
    return fail(e)
  }
  refresh()
  redirect("/catalog/manage?flash=" + encodeURIComponent("Category deleted"))
}

/* ── items ─────────────────────────────────────────────────────────────── */

export async function createItemAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission(PERM)
  let id: string
  try {
    id = await createCatalogItem(actor, itemInput(fd))
  } catch (e) {
    return fail(e)
  }
  refresh()
  redirect(`/catalog/manage/items/${id}?flash=${encodeURIComponent("Item created. Now build its request form.")}`)
}

export async function updateItemAction(id: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    await updateCatalogItem(actor, id, itemInput(fd))
  } catch (e) {
    return fail(e)
  }
  refresh(id)
  return ok("Saved")
}

export async function deleteItemAction(id: string): Promise<FormState> {
  const actor = await requirePermission(PERM)
  try {
    await deleteCatalogItem(actor, id)
  } catch (e) {
    return fail(e)
  }
  refresh()
  redirect("/catalog/manage?flash=" + encodeURIComponent("Item deleted"))
}

export async function saveFormAction(id: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission(PERM)
  let n: number
  try {
    const rows: FieldRowInput[] = []
    const count = int(fd.get("rowCount"), 0, 0, 200)
    for (let i = 0; i < count; i++) {
      const get = (k: string) => {
        const v = fd.get(`rows.${i}.${k}`)
        return typeof v === "string" ? v : null
      }
      rows.push({
        sort: get("sort"),
        key: get("key"),
        label: get("label"),
        type: get("type"),
        options: get("options"),
        required: bool(get("required")),
        help: get("help"),
        remove: bool(get("remove")),
      })
    }
    n = await setCatalogItemForm(actor, id, rows)
  } catch (e) {
    return fail(e)
  }
  refresh(id)
  return ok(n === 1 ? "Form saved (1 field)" : `Form saved (${n} fields)`)
}

export async function saveTasksAction(id: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission(PERM)
  let n: number
  try {
    n = await setCatalogItemTasks(actor, id, String(fd.get("tasks") ?? ""))
  } catch (e) {
    return fail(e)
  }
  refresh(id)
  return ok(n === 1 ? "Saved 1 task" : `Saved ${n} tasks`)
}

export async function starterItemsAction(): Promise<FormState> {
  const actor = await requirePermission(PERM)
  let result: { created: string[]; skipped: string[] }
  try {
    result = await createStarterItems(actor)
  } catch (e) {
    return fail(e)
  }
  refresh()
  if (!result.created.length) return ok("The starter items already exist")
  return ok(`Created ${result.created.join(", ")}${result.skipped.length ? ` (already there: ${result.skipped.join(", ")})` : ""}`)
}
