"use client"
/** Client pieces of the knowledge base: the Markdown editor with preview, and a copyable snippet. */
import { useRef, useState } from "react"
import { renderMarkdown } from "@/lib/kb/markdown"

/**
 * Textarea with a Preview tab. The preview uses the same safe renderer as the
 * article page (renderMarkdown escapes everything first), so it shows exactly
 * what readers will see. The textarea stays in the form while previewing.
 */
export function MarkdownEditor({ name, id, defaultValue, rows = 18 }: { name: string; id?: string; defaultValue?: string; rows?: number }) {
  const [value, setValue] = useState(defaultValue ?? "")
  const [tab, setTab] = useState<"write" | "preview" | "split">("write")
  const tabBtn = (t: typeof tab, label: string) => (
    <button type="button" className={`btn btn-sm ${tab === t ? "" : "btn-ghost"}`} aria-pressed={tab === t} onClick={() => setTab(t)}>
      {label}
    </button>
  )
  const preview = (
    <div
      className="md min-h-40 overflow-x-auto rounded-md border border-slate-200 bg-white p-3 text-sm"
      // safe: renderMarkdown escapes all HTML and allow-lists URLs (see src/lib/kb/markdown.ts)
      dangerouslySetInnerHTML={{ __html: renderMarkdown(value) || '<p class="text-slate-400">Nothing to preview yet.</p>' }}
    />
  )
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-1">
        {tabBtn("write", "Write")}
        {tabBtn("preview", "Preview")}
        <span className="hidden lg:inline">{tabBtn("split", "Side by side")}</span>
        <span className="ml-auto text-xs text-slate-500">
          Markdown: <code># Heading</code> <code>**bold**</code> <code>*italic*</code> <code>`code`</code> <code>- list</code> <code>&gt; quote</code> <code>| table |</code> <code>[link](https://…)</code>
        </span>
      </div>
      <div className={tab === "split" ? "grid gap-3 lg:grid-cols-2" : ""}>
        <textarea
          id={id}
          name={name}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={rows}
          spellCheck
          className={`input font-mono text-[13px] leading-relaxed ${tab === "preview" ? "hidden" : ""}`}
        />
        {tab !== "write" && preview}
      </div>
    </div>
  )
}

/** Read-only text with a Copy button (falls back to selecting the text when the clipboard API is unavailable). */
export function CopyField({ value, label = "Copy" }: { value: string; label?: string }) {
  const ref = useRef<HTMLInputElement>(null)
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      ref.current?.select()
      document.execCommand?.("copy")
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="flex min-w-0 gap-1">
      <input ref={ref} readOnly value={value} className="input min-w-0 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} aria-label="Markdown snippet" />
      <button type="button" className="btn btn-sm shrink-0" onClick={copy}>
        {copied ? "Copied" : label}
      </button>
    </div>
  )
}
