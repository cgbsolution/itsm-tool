/** Server-rendered pieces shared by the knowledge base pages. */
import { Badge, Field, type Tone } from "@/components/ui"
import { KB_STATUS_LABELS, KB_VISIBILITY_LABELS, KB_VISIBILITIES, type KbStatus } from "@/lib/kb/service"
import { MarkdownEditor } from "./client"

const STATUS_TONE: Record<KbStatus, Tone> = { draft: "blue", review: "amber", published: "green", retired: "gray" }

export function KbStatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status as KbStatus] ?? "gray"}>{KB_STATUS_LABELS[status as KbStatus] ?? status}</Badge>
}

export function VisibilityBadge({ visibility }: { visibility: string }) {
  return visibility === "internal" ? (
    <Badge tone="purple" title="Only the IT team can read this article">
      Internal
    </Badge>
  ) : (
    <Badge title="Everyone who can sign in can read this article">Public</Badge>
  )
}

type ArticleValues = { title: string; summary: string | null; body: string; category_id: string | null; tags: string[]; visibility: string }

/** Title, summary, body (with preview), category, tags and visibility. */
export function ArticleFields({ article, categories, allowAttachments }: { article?: ArticleValues; categories: { id: string; name: string }[]; allowAttachments?: boolean }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
      <div className="min-w-0 space-y-4">
        <Field label="Title" htmlFor="title" required>
          <input id="title" name="title" className="input" required maxLength={300} defaultValue={article?.title ?? ""} placeholder="How to connect to the VPN" />
        </Field>
        <Field label="Summary" htmlFor="summary" hint="One or two sentences shown in search results.">
          <textarea id="summary" name="summary" className="input" rows={2} maxLength={1000} defaultValue={article?.summary ?? ""} />
        </Field>
        <Field label="Article" htmlFor="body">
          <MarkdownEditor id="body" name="body" defaultValue={article?.body ?? ""} />
        </Field>
      </div>
      <div className="space-y-4">
        <Field label="Category" htmlFor="categoryId">
          <select id="categoryId" name="categoryId" className="input" defaultValue={article?.category_id ?? ""}>
            <option value="">— None —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tags" htmlFor="tags" hint="Comma-separated, e.g. vpn, remote access">
          <input id="tags" name="tags" className="input" defaultValue={article?.tags.join(", ") ?? ""} />
        </Field>
        <fieldset>
          <legend className="label">Who can read it</legend>
          <div className="space-y-1.5">
            {KB_VISIBILITIES.map((v) => (
              <label key={v} className="flex items-start gap-2 text-sm">
                <input type="radio" name="visibility" value={v} defaultChecked={(article?.visibility ?? "internal") === v} className="mt-0.5" />
                <span>{KB_VISIBILITY_LABELS[v]}</span>
              </label>
            ))}
          </div>
          <p className="hint">Only published articles are shown to readers.</p>
        </fieldset>
        {allowAttachments && (
          <Field label="Attachments" htmlFor="files" hint="Images and documents, up to 10 files. After saving, the edit page gives you a Markdown snippet for each file.">
            <input id="files" type="file" name="files" multiple className="block w-full text-sm" />
          </Field>
        )}
      </div>
    </div>
  )
}
