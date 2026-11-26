"use server"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { requirePermission } from "@/lib/auth/session"
import { fail, ok, type FormState } from "@/lib/actions"
import { bool, formObject, str } from "@/lib/validate"
import { AppError } from "@/lib/errors"
import {
  addRelationship, assignCi, createCi, createClass, deleteCi, deleteClass, removeRelationship, retireCi, returnCi, updateCi, updateClass,
} from "@/lib/cmdb/service"
import { attributeSchemaFromForm, ciInputFromForm } from "@/lib/cmdb/forms"
import { commitImport, stageImport } from "@/lib/cmdb/import"

export async function createCiAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("cmdb.edit")
  let id: string
  try {
    const ci = await createCi(actor, ciInputFromForm(formObject(fd)))
    id = ci.id
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/cmdb")
  redirect(`/cmdb/${id}?flash=${encodeURIComponent("Configuration item created")}`)
}

export async function updateCiAction(ciId: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("cmdb.edit")
  try {
    await updateCi(actor, ciId, ciInputFromForm(formObject(fd)))
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/cmdb/${ciId}`)
  redirect(`/cmdb/${ciId}?flash=${encodeURIComponent("Saved")}`)
}

export async function retireCiAction(ciId: string): Promise<FormState> {
  const actor = await requirePermission("cmdb.edit")
  try {
    await retireCi(actor, ciId)
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/cmdb/${ciId}`)
  return ok("Retired")
}

export async function deleteCiAction(ciId: string): Promise<FormState> {
  const actor = await requirePermission("cmdb.delete")
  let code: string
  try {
    code = (await deleteCi(actor, ciId)).ci_code
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/cmdb")
  redirect("/cmdb?flash=" + encodeURIComponent(`${code} deleted`))
}

export async function addRelationshipAction(ciId: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("cmdb.edit")
  try {
    await addRelationship(actor, ciId, String(fd.get("targetCode") ?? ""), String(fd.get("relType") ?? ""))
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/cmdb/${ciId}`)
  return ok("Relationship added")
}

export async function removeRelationshipAction(ciId: string, relationshipId: string): Promise<FormState> {
  const actor = await requirePermission("cmdb.edit")
  try {
    await removeRelationship(actor, ciId, relationshipId)
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/cmdb/${ciId}`)
  return ok("Relationship removed")
}

export async function assignCiAction(ciId: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("cmdb.edit")
  try {
    await assignCi(actor, ciId, String(fd.get("userId") ?? ""), str(fd.get("note"), 1000))
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/cmdb/${ciId}`)
  return ok("Assigned")
}

export async function returnCiAction(ciId: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("cmdb.edit")
  try {
    await returnCi(actor, ciId, str(fd.get("note"), 1000))
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/cmdb/${ciId}`)
  return ok("Returned")
}

/* ── import ────────────────────────────────────────────────────────────── */

export async function uploadImportAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("cmdb.edit")
  let fileId: string
  try {
    const file = fd.get("file")
    if (!file || typeof file === "string") throw new AppError("Choose a CSV file first")
    fileId = await stageImport(actor, file)
  } catch (e) {
    return fail(e)
  }
  redirect(`/cmdb/import?file=${fileId}`)
}

export async function commitImportAction(fileId: string): Promise<FormState> {
  const actor = await requirePermission("cmdb.edit")
  let message: string
  try {
    const s = await commitImport(actor, fileId)
    message = `Import finished: ${s.created} created, ${s.updated} updated, ${s.unchanged} unchanged, ${s.skipped} skipped`
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/cmdb")
  redirect(`/cmdb/import?file=${fileId}&flash=${encodeURIComponent(message)}`)
}

/* ── classes ───────────────────────────────────────────────────────────── */

export async function saveClassAction(classId: string | null, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("admin.itsm")
  let id: string
  try {
    const o = formObject(fd)
    const input = {
      key: String(o.key ?? ""),
      name: String(o.name ?? ""),
      category: String(o.category ?? ""),
      attributes: attributeSchemaFromForm(o),
      isActive: classId ? bool(o.isActive) : undefined,
    }
    if (classId) {
      await updateClass(actor, classId, input)
      id = classId
    } else {
      id = (await createClass(actor, input)).id
    }
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/cmdb/classes")
  redirect(`/cmdb/classes?flash=${encodeURIComponent(classId ? "Class saved" : "Class created")}#c-${id}`)
}

export async function deleteClassAction(classId: string): Promise<FormState> {
  const actor = await requirePermission("admin.itsm")
  try {
    await deleteClass(actor, classId)
  } catch (e) {
    return fail(e)
  }
  revalidatePath("/cmdb/classes")
  redirect("/cmdb/classes?flash=" + encodeURIComponent("Class deleted"))
}
