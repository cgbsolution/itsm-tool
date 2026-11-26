import Link from "next/link"
import { notFound } from "next/navigation"
import { requirePermission } from "@/lib/auth/session"
import { AppError } from "@/lib/errors"
import { articleFiles, getArticle, kbCategories } from "@/lib/kb/queries"
import { fileSnippet } from "@/lib/kb/service"
import { bytes } from "@/lib/format"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, PageHeader } from "@/components/ui"
import { deleteArticleFileAction, updateArticleAction, uploadArticleFilesAction } from "../../actions"
import { ArticleFields, KbStatusBadge } from "../../parts"
import { CopyField } from "../../client"

export const metadata = { title: "Edit article" }

export default async function EditArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("kb.write")
  const { id } = await params
  let a
  try {
    a = await getArticle(actor, decodeURIComponent(id))
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  const [categories, files] = await Promise.all([kbCategories(actor), articleFiles(actor, a.id)])

  return (
    <>
      <PageHeader
        title={`Edit ${a.number}`}
        subtitle={
          <span className="flex items-center gap-2">
            <KbStatusBadge status={a.status} /> version {a.version} · saving creates version {a.version + 1}
          </span>
        }
        back={{ href: `/kb/${a.id}`, label: a.title }}
      />
      <div className="space-y-4">
        <ActionForm action={updateArticleAction.bind(null, a.id, a.version)}>
          <Card>
            <ArticleFields article={a} categories={categories} />
            <div className="mt-4 flex justify-end gap-2 border-t border-slate-100 pt-4">
              <Link href={`/kb/${a.id}`} className="btn btn-ghost">
                Cancel
              </Link>
              <SubmitButton pendingText="Saving…">Save</SubmitButton>
            </div>
          </Card>
        </ActionForm>

        <Card title={`Attachments and images (${files.length})`}>
          <p className="mb-3 text-sm text-slate-600">
            Upload a file, then copy its snippet into the article. Images show inline; other files become a download link. Readers can open them only while they can read the article.
          </p>
          {files.length > 0 && (
            <ul className="mb-4 divide-y divide-slate-100">
              {files.map((f) => (
                <li key={f.id} className="grid gap-2 py-2 sm:grid-cols-[minmax(0,14rem)_1fr_auto] sm:items-center">
                  <span className="min-w-0">
                    <a href={`/api/files/${f.id}${f.content_type.startsWith("image/") ? "?inline=1" : ""}`} className="block truncate text-sm" target="_blank" rel="noopener noreferrer">
                      {f.file_name}
                    </a>
                    <span className="text-xs text-slate-400">
                      {f.content_type} · {bytes(f.size_bytes)}
                    </span>
                  </span>
                  <CopyField value={fileSnippet(f)} />
                  <ActionForm action={deleteArticleFileAction.bind(null, a.id, f.id)} confirm={`Remove ${f.file_name}? Links to it in the article will stop working.`}>
                    <SubmitButton className="btn btn-sm btn-ghost text-red-600">Remove</SubmitButton>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
          <ActionForm action={uploadArticleFilesAction.bind(null, a.id)} resetOnSuccess className="flex flex-wrap items-center gap-2">
            <input type="file" name="files" multiple className="min-w-0 flex-1 text-sm" aria-label="Files to upload" />
            <SubmitButton className="btn" pendingText="Uploading…">
              Upload
            </SubmitButton>
          </ActionForm>
          <p className="hint">Save your text changes first: uploading does not save the article.</p>
        </Card>
      </div>
    </>
  )
}
