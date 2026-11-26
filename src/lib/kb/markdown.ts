/**
 * Safe Markdown → HTML for knowledge articles and catalog descriptions.
 * No dependencies; pure, so it runs on the server and in the browser (editor preview).
 *
 * Security model
 * - The whole source is HTML-escaped first (& < > " '), so user text can never
 *   contain markup. Every tag in the output is a fixed string produced here.
 * - The only user-controlled attribute values are link / image URLs and image alt
 *   text. URLs are decoded, checked against a strict character allow-list and a
 *   scheme allow-list (links: http(s), mailto, relative "/path"; images: only
 *   "/api/files/…"), then escaped again. Alt text is escaped text.
 * - Control characters are stripped, so the private placeholder markers used
 *   while parsing inline syntax (\u0000n\u0000) cannot be forged.
 *
 * Supported: # to ### headings, paragraphs, **bold**, *italic* / _italic_,
 * `code`, fenced code blocks, - / * / 1. lists (nested by indentation),
 * > quotes, ---, simple pipe tables, [text](url), ![alt](/api/files/…), \-escapes.
 */

const MAX_INPUT = 200_000
const MAX_DEPTH = 8

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
const UNESC: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c])
}

/** Reverses escapeHtml exactly (one left-to-right pass, so "&amp;lt;" → "&lt;"). */
function unescapeHtml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => UNESC[e])
}

/* ── URLs ──────────────────────────────────────────────────────────────── */

// No quotes, angle brackets, whitespace, backslashes, parentheses or control characters.
const URL_CHARS = /^[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+$/
const IMAGE_URL = /^\/api\/files\/[A-Za-z0-9-]{1,64}(?:\?[A-Za-z0-9=&_-]{0,64})?$/

export function safeLinkUrl(escapedUrl: string): { href: string; external: boolean } | null {
  const u = unescapeHtml(escapedUrl)
  if (!u || u.length > 2000 || !URL_CHARS.test(u)) return null
  if (/^https?:\/\/[A-Za-z0-9[]/i.test(u)) return { href: escapeHtml(u), external: true }
  if (/^mailto:[A-Za-z0-9._%+-]/i.test(u)) return { href: escapeHtml(u), external: false }
  if (/^\/(?![/\\])/.test(u)) return { href: escapeHtml(u), external: false }
  return null
}

export function safeImageUrl(escapedUrl: string): string | null {
  const u = unescapeHtml(escapedUrl)
  return IMAGE_URL.test(u) ? escapeHtml(u) : null
}

/* ── inline ────────────────────────────────────────────────────────────── */

type Tok = { html: string; text: string }
const MARK = /\u0000(\d+)\u0000/g

function restore(s: string, toks: Tok[], depth = 0): string {
  if (depth > 12) return s.replace(MARK, "")
  return s.replace(MARK, (_, n: string) => restore(toks[Number(n)]?.html ?? "", toks, depth + 1))
}

function plain(s: string, toks: Tok[], depth = 0): string {
  if (depth > 12) return s.replace(MARK, "")
  return s.replace(MARK, (_, n: string) => plain(toks[Number(n)]?.text ?? "", toks, depth + 1))
}

function emphasis(s: string): string {
  return s
    .replace(/\*\*(?=[^\s*])([^*\n]*?[^\s*])\*\*/g, "<strong>$1</strong>")
    .replace(/\*(?=[^\s*])([^*\n]*?[^\s*])\*/g, "<em>$1</em>")
    .replace(/(^|[\s(])_(?=[^\s_])([^_\n]*?[^\s_])_(?=$|[\s).,;:!?])/g, "$1<em>$2</em>")
}

/** Inline syntax on already-escaped text. */
function inline(escaped: string): string {
  const toks: Tok[] = []
  const put = (html: string, text: string) => {
    toks.push({ html, text })
    return `\u0000${toks.length - 1}\u0000`
  }
  let s = escaped
  // 1. code spans: their content is literal
  s = s.replace(/`([^`\n]+)`/g, (_, c: string) => put(`<code>${c}</code>`, c))
  // 2. backslash escapes
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, (_, ch: string) => put(ch, ch))
  // 3. images (only our own file URLs); anything else stays literal text
  s = s.replace(/!\[([^[\]\n]*)\]\(([^()\s]*)\)/g, (m: string, alt: string, url: string) => {
    const src = safeImageUrl(url)
    if (!src) return put(m, m)
    const altText = plain(alt, toks).replace(/[\u0000"<>]/g, "")
    return put(`<img src="${src}" alt="${altText}" loading="lazy" class="max-w-full rounded">`, altText)
  })
  // 4. links; the label gets emphasis, never another link
  s = s.replace(/\[([^[\]\n]*)\]\(([^()\s]*)\)/g, (m: string, label: string, url: string) => {
    const link = safeLinkUrl(url)
    if (!link) return m
    const attrs = link.external ? ' target="_blank" rel="noopener noreferrer"' : ""
    const text = label.trim() ? emphasis(label) : link.href
    return put(`<a href="${link.href}"${attrs}>${text}</a>`, plain(label, toks))
  })
  // 5. emphasis on the remaining text, then put the pieces back
  return restore(emphasis(s), toks)
}

/* ── blocks ────────────────────────────────────────────────────────────── */

type ListItem = { indent: number; ordered: boolean; start: number; content: string; contentIndent: number }

const isBlank = (l: string) => l.trim() === ""
const indentOf = (l: string) => l.length - l.trimStart().length

function fenceOf(l: string): string | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l)
  if (!m) return null
  const info = m[2].trim()
  if (!/^[A-Za-z0-9_+.#-]*$/.test(info)) return null
  return m[1]
}

function headingOf(l: string): { level: number; text: string } | null {
  const m = /^ {0,3}(#{1,6})(?: +(.*))?$/.exec(l)
  if (!m) return null
  let t = (m[2] ?? "").trim()
  let end = t.length
  while (end > 0 && t[end - 1] === "#") end--
  if (end === 0) t = ""
  else if (end < t.length && t[end - 1] === " ") t = t.slice(0, end).trimEnd()
  return { level: Math.min(m[1].length, 3), text: t }
}

const isHr = (l: string) => /^ {0,3}([-*_])(?: *\1){2,} *$/.test(l)
const QUOTE = /^ {0,3}&gt; ?(.*)$/

function listItemOf(l: string): ListItem | null {
  const m = /^( *)([-*+]|\d{1,9}[.)])(?:( +)(.*))?$/.exec(l)
  if (!m || isHr(l)) return null
  const indent = m[1].length
  const ordered = /\d/.test(m[2])
  const spaces = m[3]?.length ?? 1
  return {
    indent,
    ordered,
    start: ordered ? parseInt(m[2], 10) : 1,
    content: m[4] ?? "",
    contentIndent: indent + m[2].length + (spaces > 4 ? 1 : spaces),
  }
}

function splitRow(l: string): string[] {
  let s = l.trim()
  if (s.startsWith("|")) s = s.slice(1)
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ""
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "\\|"
      i++
    } else if (s[i] === "|") {
      cells.push(cur.trim())
      cur = ""
    } else cur += s[i]
  }
  cells.push(cur.trim())
  return cells
}

type Align = "left" | "center" | "right" | null

function tableAligns(l: string): Align[] | null {
  if (!l.includes("|") || !l.includes("-")) return null
  const cells = splitRow(l)
  if (!cells.every((c) => /^:?-+:?$/.test(c))) return null
  return cells.map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null))
}

const isTableStart = (l: string, next: string | undefined) => l.includes("|") && next !== undefined && tableAligns(next) !== null

/** Lines that end a paragraph because they start another block. */
function startsBlock(l: string, next: string | undefined): boolean {
  if (fenceOf(l) || headingOf(l) || isHr(l) || QUOTE.test(l) || isTableStart(l, next)) return true
  const li = listItemOf(l)
  return !!li && li.content.trim() !== "" && (!li.ordered || li.start === 1)
}

function cell(tag: "th" | "td", content: string, align: Align): string {
  const cls = tag === "th" ? "border border-slate-200 bg-slate-50 px-2 py-1 text-left font-semibold" : "border border-slate-200 px-2 py-1 align-top"
  return `<${tag} class="${cls}"${align ? ` style="text-align:${align}"` : ""}>${inline(content)}</${tag}>`
}

function renderBlocks(lines: string[], depth: number, tight = false): string {
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (isBlank(line)) {
      i++
      continue
    }

    // fenced code
    const fence = fenceOf(line)
    if (fence) {
      const code: string[] = []
      i++
      while (i < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,}) *$/.exec(lines[i])
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length) break
        code.push(lines[i])
        i++
      }
      i++ // closing fence (or end of input)
      out.push(`<pre><code>${code.join("\n")}</code></pre>`)
      continue
    }

    const h = headingOf(line)
    if (h) {
      out.push(`<h${h.level}>${inline(h.text)}</h${h.level}>`)
      i++
      continue
    }

    if (isHr(line)) {
      out.push('<hr class="my-4 border-slate-200">')
      i++
      continue
    }

    // block quote (nested quotes recurse, up to a depth limit)
    if (QUOTE.test(line) && depth < MAX_DEPTH) {
      const inner: string[] = []
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i])
        if (m) inner.push(m[1])
        else if (!isBlank(lines[i]) && inner.length && !isBlank(inner[inner.length - 1]) && !startsBlock(lines[i], lines[i + 1])) inner.push(lines[i])
        else break
        i++
      }
      out.push(`<blockquote>${renderBlocks(inner, depth + 1)}</blockquote>`)
      continue
    }

    // table
    if (isTableStart(line, lines[i + 1])) {
      const aligns = tableAligns(lines[i + 1])!
      const head = splitRow(line)
      const cols = Math.max(head.length, aligns.length)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]))
        i++
      }
      const row = (cells: string[], tag: "th" | "td") =>
        `<tr>${Array.from({ length: cols }, (_, c) => cell(tag, cells[c] ?? "", aligns[c] ?? null)).join("")}</tr>`
      out.push(
        `<div class="my-2 overflow-x-auto"><table class="border-collapse text-sm"><thead>${row(head, "th")}</thead>` +
          `<tbody>${rows.map((r) => row(r, "td")).join("")}</tbody></table></div>`
      )
      continue
    }

    // list
    const first = listItemOf(line)
    if (first && depth < MAX_DEPTH) {
      const items: string[][] = [[first.content]]
      let contentIndent = first.contentIndent
      let loose = false
      i++
      while (i < lines.length) {
        const l = lines[i]
        const li = listItemOf(l)
        if (li && li.ordered === first.ordered && li.indent < contentIndent) {
          items.push([li.content])
          contentIndent = li.contentIndent
          i++
          continue
        }
        if (isBlank(l)) {
          let j = i + 1
          while (j < lines.length && isBlank(lines[j])) j++
          if (j >= lines.length) break
          const next = lines[j]
          const nli = listItemOf(next)
          if (indentOf(next) >= contentIndent || (nli && nli.ordered === first.ordered && nli.indent < contentIndent)) {
            for (let k = i; k < j; k++) items[items.length - 1].push("")
            loose = true
            i = j
            continue
          }
          break
        }
        if (indentOf(l) >= contentIndent) {
          items[items.length - 1].push(l.slice(contentIndent))
          i++
          continue
        }
        // lazy continuation of the item's paragraph
        const cur = items[items.length - 1]
        if (!isBlank(cur[cur.length - 1]) && !startsBlock(l, lines[i + 1]) && !li) {
          cur.push(l.trim())
          i++
          continue
        }
        break
      }
      const tag = first.ordered ? "ol" : "ul"
      const start = first.ordered && first.start !== 1 ? ` start="${first.start}"` : ""
      out.push(`<${tag}${start}>${items.map((it) => `<li>${renderBlocks(it, depth + 1, !loose)}</li>`).join("")}</${tag}>`)
      continue
    }

    // paragraph
    const para: string[] = [line.trim()]
    i++
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i], lines[i + 1])) {
      para.push(lines[i].trim())
      i++
    }
    const html = inline(para.join("\n"))
    out.push(tight ? html : `<p>${html}</p>`)
  }
  return out.join(tight ? "\n" : "")
}

export function renderMarkdown(src: string): string {
  if (typeof src !== "string" || !src) return ""
  const text = src
    .slice(0, MAX_INPUT)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  return renderBlocks(escapeHtml(text).split("\n"), 0)
}

/** Plain-text excerpt of Markdown (for lists and suggestions). */
export function markdownExcerpt(src: string | null | undefined, max = 200): string {
  if (!src) return ""
  const t = src
    .slice(0, 5000)
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`|~]+/g, " ")
    .replace(/^\s*[-+]\s+/gm, " ")
    .replace(/\s+/g, " ")
    .trim()
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t
}
