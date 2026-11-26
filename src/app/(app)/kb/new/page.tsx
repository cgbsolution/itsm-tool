import { requirePermission } from "@/lib/auth/session"
import { kbCategories } from "@/lib/kb/queries"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, PageHeader } from "@/components/ui"
import { createArticleAction } from "../actions"
import { ArticleFields } from "../parts"

export const metadata = { title: "New article" }

export default async function NewArticlePage() {
  const actor = await requirePermission("kb.write")
  const categories = await kbCategories(actor)
  return (
    <>
      <PageHeader title="New knowledge article" subtitle="It is saved as a draft. Submit it for review when it is ready." back={{ href: "/kb", label: "Knowledge base" }} />
      <ActionForm action={createArticleAction}>
        <Card>
          <ArticleFields categories={categories} allowAttachments />
          <div className="mt-4 flex justify-end gap-2 border-t border-slate-100 pt-4">
            <SubmitButton pendingText="Saving…">Save draft</SubmitButton>
          </div>
        </Card>
      </ActionForm>
    </>
  )
}
