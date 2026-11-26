import { describe, expect, it } from "vitest"
import { renderMarkdown, markdownExcerpt, safeLinkUrl, safeImageUrl, escapeHtml } from "@/lib/kb/markdown"

/**
 * Structural safety check: every tag in the output must be one the renderer
 * produces, with only the attributes it produces, and URL attributes must be
 * safe. Because user text is escaped, any "<" in the output starts one of our tags.
 */
const TAGS = new Set(["p", "h1", "h2", "h3", "strong", "em", "code", "pre", "ul", "ol", "li", "blockquote", "hr", "a", "img", "table", "thead", "tbody", "tr", "th", "td", "div"])
const ATTRS = new Set(["href", "src", "alt", "target", "rel", "start", "class", "style", "loading"])

function assertSafe(html: string) {
  const tagRe = /<\/?([a-zA-Z0-9]+)([^>]*)>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html))) {
    const [, tag, rest] = m
    expect(TAGS.has(tag.toLowerCase()), `unexpected tag <${tag}>`).toBe(true)
    // attributes are name="value" pairs with no quotes inside the value
    const stripped = rest.replace(/\s+([a-z-]+)="([^"<>]*)"/g, (_, name: string, value: string) => {
      expect(ATTRS.has(name), `unexpected attribute ${name} on <${tag}>`).toBe(true)
      if (name === "href") expect(value).toMatch(/^(https?:\/\/|mailto:|\/(?![/\\]))/i)
      if (name === "src") expect(value).toMatch(/^\/api\/files\//)
      if (name === "style") expect(value).toMatch(/^text-align:(left|center|right)$/)
      return ""
    })
    expect(stripped.trim(), `unparsed attribute text in <${tag}${rest}>`).toBe("")
  }
  // nothing that looks like a tag survives unescaped, and no event handler sits outside a quoted value
  expect(html).not.toMatch(/<(script|iframe|object|embed|svg|math|style|form|input|link|meta|base)\b/i)
  expect(tagsOnly(html)).not.toMatch(/<[^>]*\son[a-z]+\s*=/i)
  expect(html).not.toContain("\u0000")
}

/** The HTML with every quoted attribute value emptied. */
const tagsOnly = (html: string) => html.replace(/"[^"]*"/g, '""')

const render = (s: string) => {
  const html = renderMarkdown(s)
  assertSafe(html)
  return html
}

describe("renderMarkdown: formatting", () => {
  it("renders headings, paragraphs and emphasis", () => {
    expect(render("# Title")).toBe("<h1>Title</h1>")
    expect(render("## Sub ##")).toBe("<h2>Sub</h2>")
    expect(render("### Three")).toBe("<h3>Three</h3>")
    expect(render("#### Four")).toBe("<h3>Four</h3>")
    expect(render("#hashtag")).toBe("<p>#hashtag</p>")
    expect(render("Hello **bold** and *italic* and _also_ `x < y`")).toBe(
      "<p>Hello <strong>bold</strong> and <em>italic</em> and <em>also</em> <code>x &lt; y</code></p>"
    )
    expect(render("para one\nstill one\n\npara two")).toBe("<p>para one\nstill one</p><p>para two</p>")
    expect(render("snake_case_name stays")).toBe("<p>snake_case_name stays</p>")
    expect(render("2 * 3 * 4")).toBe("<p>2 * 3 * 4</p>")
  })

  it("renders fenced code literally", () => {
    expect(render("```js\nconst a = '<b>' && **x**\n```")).toBe("<pre><code>const a = &#39;&lt;b&gt;&#39; &amp;&amp; **x**</code></pre>")
    expect(render("~~~\nunclosed\n# not a heading")).toBe("<pre><code>unclosed\n# not a heading</code></pre>")
  })

  it("renders lists, nested lists and ordered start numbers", () => {
    expect(render("- one\n- two\n* three")).toBe("<ul><li>one</li><li>two</li><li>three</li></ul>")
    expect(render("1. first\n2. second")).toBe("<ol><li>first</li><li>second</li></ol>")
    expect(render("3. third\n4. fourth")).toBe('<ol start="3"><li>third</li><li>fourth</li></ol>')
    expect(render("- a\n  - nested\n- b")).toBe("<ul><li>a\n<ul><li>nested</li></ul></li><li>b</li></ul>")
    expect(render("Steps:\n1. Open\n2. Click")).toBe("<p>Steps:</p><ol><li>Open</li><li>Click</li></ol>")
    expect(render("- a\n\n- b")).toBe("<ul><li><p>a</p></li><li><p>b</p></li></ul>")
  })

  it("renders quotes, rules and tables", () => {
    expect(render("> quoted\n> text")).toBe("<blockquote><p>quoted\ntext</p></blockquote>")
    expect(render("> outer\n> > inner")).toBe("<blockquote><p>outer</p><blockquote><p>inner</p></blockquote></blockquote>")
    expect(render("---")).toBe('<hr class="my-4 border-slate-200">')
    const t = render("| Name | Port |\n|:-----|-----:|\n| SSH | 22 |\n| a \\| b | **x** |")
    expect(t).toContain("<thead><tr><th")
    expect(t).toContain('style="text-align:right">22</td>')
    expect(t).toContain(">a | b</td>")
    expect(t).toContain("<strong>x</strong>")
    expect(render("a | b\nno separator")).toBe("<p>a | b\nno separator</p>")
  })

  it("renders allowed links and images", () => {
    expect(render("[Docs](https://example.com/a?b=1&c=2)")).toBe(
      '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">Docs</a></p>'
    )
    expect(render("[KB](/kb/123)")).toBe('<p><a href="/kb/123">KB</a></p>')
    expect(render("[Mail](mailto:it@example.com)")).toBe('<p><a href="mailto:it@example.com">Mail</a></p>')
    expect(render("![diagram](/api/files/3f1c0e2a-0000-4000-8000-000000000001?inline=1)")).toBe(
      '<p><img src="/api/files/3f1c0e2a-0000-4000-8000-000000000001?inline=1" alt="diagram" loading="lazy" class="max-w-full rounded"></p>'
    )
    expect(render("[![x](/api/files/abc)](/kb/1)")).toBe('<p><a href="/kb/1"><img src="/api/files/abc" alt="x" loading="lazy" class="max-w-full rounded"></a></p>')
    expect(render("[**bold** link](/kb)")).toBe('<p><a href="/kb"><strong>bold</strong> link</a></p>')
    expect(render("\\*not italic\\*")).toBe("<p>*not italic*</p>")
  })
})

describe("renderMarkdown: XSS", () => {
  it("escapes raw HTML", () => {
    const html = render("<script>alert(1)</script>")
    expect(html).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>")
    expect(render("<img src=x onerror=alert(1)>")).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>")
    expect(render('<a href="javascript:alert(1)">x</a>')).not.toContain("<a ")
    expect(render("<svg/onload=alert(1)>")).not.toContain("<svg")
    expect(render("**<b onmouseover=alert(1)>**")).toBe("<p><strong>&lt;b onmouseover=alert(1)&gt;</strong></p>")
    expect(render("# <iframe src=//evil>")).toBe("<h1>&lt;iframe src=//evil&gt;</h1>")
    expect(render("| <x> |\n|---|\n| <script> |")).not.toMatch(/<(x|script)\b/)
    expect(render("- <script>\n> <script>")).not.toMatch(/<script/)
  })

  it("refuses javascript:, data:, vbscript: and protocol-relative links", () => {
    for (const url of [
      "javascript:alert(1)",
      "javascript:alert`1`",
      "JaVaScRiPt:alert(document.domain)",
      "javascript&#58;alert(1)",
      "&#106;avascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "vbscript:msgbox",
      "//evil.example.com",
      "/\\evil.example.com",
      "file:///etc/passwd",
      "java\u0000script:alert(1)",
      "java\tscript:alert(1)",
    ]) {
      const html = render(`[click](${url})`)
      expect(html, url).not.toContain("<a ")
    }
    expect(safeLinkUrl("javascript:alert(1)")).toBeNull()
    expect(safeLinkUrl(" https://x")).toBeNull()
  })

  it("only allows images from /api/files/", () => {
    for (const url of ["https://evil.example.com/x.png", "data:image/svg+xml;base64,PHN2Zz4=", "javascript:alert(1)", "/api/files/../../logout", "/api/filesx/1", "//api/files/1", "/api/files/1\"onerror=\"alert(1)"]) {
      const html = render(`![x](${url})`)
      expect(html, url).not.toContain("<img")
      expect(html, url).not.toContain("<a ")
    }
    expect(safeImageUrl("/api/files/abc?inline=1")).toBe("/api/files/abc?inline=1")
  })

  it("does not let quotes in URLs or alt text break out of attributes", () => {
    const a = render('[x](https://ok.example.com/"onmouseover="alert(1))')
    expect(a).not.toContain("<a ")
    const b = render("[x](https://ok.example.com/'onmouseover='alert)")
    expect(b).not.toContain("<a ")
    const c = render('![a" onerror="alert(1)](/api/files/abc)')
    expect(c).toContain('alt="a&quot; onerror=&quot;alert(1)"')
    expect(tagsOnly(c)).not.toMatch(/<img[^>]*\sonerror=/)
    const d = render('[x](https://ok.example.com/ "title" onclick=alert(1))')
    expect(d).not.toContain("<a ")
    const e = render("[x](https://ok.example.com/<script>)")
    expect(e).not.toContain("<a ")
    expect(e).not.toContain("<script")
  })

  it("handles nested brackets without producing unsafe links", () => {
    expect(render("[[x](javascript:alert(1))](https://ok.example.com)")).not.toMatch(/href="javascript/i)
    const html = render("[a [b](https://ok.example.com) c](javascript:alert(1))")
    expect(html).toContain('<a href="https://ok.example.com"')
    expect(html).not.toMatch(/href="[^"]*javascript/i)
    expect(render("[x]([y](javascript:alert(1)))")).not.toMatch(/href="[^"]*javascript/i)
    expect(render("![[x](javascript:alert(1))](/api/files/a)")).not.toMatch(/javascript:[^<]*<\/a>/)
    expect(render("[`code`](https://ok.example.com)")).toContain("<code>code</code></a>")
  })

  it("shows HTML entities literally instead of decoding them", () => {
    expect(render("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe("<p>&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;</p>")
    expect(render("&#x3C;img src=x onerror=alert(1)&#x3E;")).not.toContain("<img")
    expect(render("[x](https://ok.example.com/&quot;onclick=&quot;alert)")).toContain('href="https://ok.example.com/&amp;quot;onclick=&amp;quot;alert"')
    expect(render("&copy; 2026")).toBe("<p>&amp;copy; 2026</p>")
  })

  it("cannot forge the internal placeholders", () => {
    const html = render("\u00000\u0000 `a` \u00001\u0000 [x](javascript:alert(1))")
    expect(html).not.toContain("\u0000")
    expect(html).not.toContain("<a ")
  })

  it("survives pathological input", () => {
    const deep = ">".repeat(5000) + " x"
    expect(() => render(deep)).not.toThrow()
    const nested = Array.from({ length: 300 }, (_, i) => " ".repeat(i * 2) + "- item").join("\n")
    expect(() => render(nested)).not.toThrow()
    const started = Date.now()
    renderMarkdown(
      [
        "*a".repeat(20_000),
        "[".repeat(20_000),
        "![".repeat(10_000),
        "| ".repeat(10_000),
        "#".repeat(10_000) + " x " + " ".repeat(10_000) + "#",
        "## " + "x ".repeat(10_000) + "#",
        "-".repeat(10_000) + "x",
        "_a ".repeat(10_000),
        "`".repeat(30_000),
      ].join("\n")
    )
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe("helpers", () => {
  it("escapes HTML", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;")
  })
  it("makes plain excerpts", () => {
    expect(markdownExcerpt("# Reset your password\n\nOpen **Settings** and [click here](/x).", 100)).toBe("Reset your password Open Settings and click here.")
    expect(markdownExcerpt("a".repeat(300), 50)).toHaveLength(50)
  })
})
