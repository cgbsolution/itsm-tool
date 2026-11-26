"use client"
/** Subject / body editor with a live preview rendered exactly as sending does. */
import { useMemo, useState } from "react"
import { layoutHtml, renderText, textToHtml } from "@/lib/email/templates"

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g

export function TemplateEditor({
  initialSubject,
  initialBody,
  placeholders,
  sample,
  brand,
}: {
  initialSubject: string
  initialBody: string
  placeholders: string[]
  sample: Record<string, unknown>
  brand: { name: string; color: string }
}) {
  const [subject, setSubject] = useState(initialSubject)
  const [body, setBody] = useState(initialBody)
  const preview = useMemo(
    () => ({
      subject: renderText(subject, sample).replace(/[\r\n]+/g, " "),
      html: layoutHtml(textToHtml(renderText(body, sample)), brand),
    }),
    [subject, body, sample, brand]
  )
  const unknown = [...new Set([...`${subject}\n${body}`.matchAll(PLACEHOLDER)].map((m) => m[1]))].filter((p) => !placeholders.includes(p))

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="space-y-3">
        <div>
          <label className="label" htmlFor="subject">
            Subject
          </label>
          <input id="subject" name="subject" className="input" required maxLength={250} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="body">
            Body
          </label>
          <textarea id="body" name="body" className="input font-mono text-xs" rows={16} required maxLength={20000} value={body} onChange={(e) => setBody(e.target.value)} />
          <p className="hint">Plain text. Links become clickable. A line whose placeholders are all empty is left out.</p>
        </div>
        <div className="rounded-md bg-slate-50 p-3 text-xs ring-1 ring-slate-200">
          <div className="mb-1 font-medium text-slate-700">Available placeholders</div>
          <div className="flex flex-wrap gap-1.5">
            {placeholders.map((p) => (
              <code key={p} className="rounded bg-white px-1.5 py-0.5 text-slate-700 ring-1 ring-slate-200">
                {`{{${p}}}`}
              </code>
            ))}
          </div>
        </div>
        {unknown.length > 0 && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
            Not a listed placeholder, so it may come out empty: {unknown.map((p) => `{{${p}}}`).join(", ")}
          </p>
        )}
      </div>
      <div>
        <div className="label">Preview with sample values</div>
        <div className="mb-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
          <span className="text-slate-500">Subject: </span>
          {preview.subject || <span className="text-slate-400">(empty)</span>}
        </div>
        <iframe title="Email preview" srcDoc={preview.html} sandbox="" className="h-[32rem] w-full rounded-md border border-slate-200 bg-white" />
      </div>
    </div>
  )
}
