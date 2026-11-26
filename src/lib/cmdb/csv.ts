/**
 * RFC 4180 CSV parser (pure, no dependencies).
 *
 * - Fields may be quoted with `"`; `""` inside a quoted field is a literal quote;
 *   quoted fields may contain delimiters and line breaks.
 * - Records end with CRLF, LF or a lone CR. Line breaks inside quoted fields
 *   become `\n`.
 * - A UTF-8 (or UTF-16) byte-order mark is removed; files that are not valid
 *   UTF-8 are read as Windows-1252 (what Excel writes on Windows).
 * - The delimiter (comma, semicolon or tab) is detected from the header line,
 *   or taken from an Excel `sep=;` first line.
 * - Empty lines are skipped. A quote inside an unquoted field is kept as text.
 */

export type CsvDelimiter = "," | ";" | "\t"

export type CsvParseResult = {
  delimiter: CsvDelimiter
  /** Records, header included */
  rows: string[][]
  /** 1-based line number where each record starts */
  lines: number[]
}

export class CsvError extends Error {
  constructor(
    message: string,
    public line: number
  ) {
    super(message)
    this.name = "CsvError"
  }
}

/** Bytes → text. Throws CsvError for binary content. */
export function decodeCsvBuffer(buf: Uint8Array): string {
  let text: string
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = new TextDecoder("utf-16le").decode(buf.subarray(2))
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    text = new TextDecoder("utf-16be").decode(buf.subarray(2))
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf)
    } catch {
      text = new TextDecoder("windows-1252").decode(buf)
    }
  }
  text = stripBom(text)
  if (text.includes("\u0000")) throw new CsvError("This is not a text (CSV) file", 1)
  return text
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Counts delimiters outside quotes on the first record and picks the most frequent (comma on a tie). */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ",": 0, ";": 0, "\t": 0 }
  let inQuotes = false
  let content = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      inQuotes = !inQuotes
      content = true
    } else if (!inQuotes && (c === "\n" || c === "\r")) {
      if (content) break // end of the first non-empty line
    } else if (!inQuotes && (c === "," || c === ";" || c === "\t")) {
      counts[c]++
      content = true
    } else if (c.trim()) content = true
  }
  let best: CsvDelimiter = ","
  for (const d of [";", "\t"] as CsvDelimiter[]) if (counts[d] > counts[best]) best = d
  return best
}

export function parseCsv(input: string, opts: { delimiter?: CsvDelimiter } = {}): CsvParseResult {
  let text = stripBom(input)
  let lineOffset = 0
  let delimiter = opts.delimiter
  const sep = /^sep=([,;\t])\r?\n?/i.exec(text)
  if (sep) {
    delimiter = delimiter ?? (sep[1] as CsvDelimiter)
    text = text.slice(sep[0].length)
    lineOffset = 1
  }
  const d = delimiter ?? detectDelimiter(text)

  const rows: string[][] = []
  const lines: number[] = []
  let row: string[] = []
  let field = ""
  let quoted = false // the current field started with a quote
  let inQuotes = false
  let line = 1 + lineOffset
  let recordLine = line
  let quoteLine = line

  const endField = () => {
    row.push(field)
    field = ""
    quoted = false
  }
  const endRecord = () => {
    const empty = row.length === 0 && field === "" && !quoted
    endField()
    if (!empty) {
      rows.push(row)
      lines.push(recordLine)
    }
    row = []
  }

  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
        } else {
          inQuotes = false
          i++
        }
      } else if (c === "\r" || c === "\n") {
        field += "\n"
        i += c === "\r" && text[i + 1] === "\n" ? 2 : 1
        line++
      } else {
        field += c
        i++
      }
      continue
    }
    if (c === '"' && field === "" && !quoted) {
      inQuotes = true
      quoted = true
      quoteLine = line
      i++
    } else if (c === d) {
      endField()
      i++
    } else if (c === "\r" || c === "\n") {
      endRecord()
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1
      line++
      recordLine = line
    } else {
      field += c
      i++
    }
  }
  if (inQuotes) throw new CsvError(`A quoted value that starts on line ${quoteLine} is never closed`, quoteLine)
  if (field !== "" || quoted || row.length > 0) endRecord()
  return { delimiter: d, rows, lines }
}
