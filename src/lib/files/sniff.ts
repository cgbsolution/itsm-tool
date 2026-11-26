/**
 * Content-type detection from the file's first bytes. The browser-declared
 * type is never trusted (legacy finding S13).
 */

const EXECUTABLE_EXT = new Set([
  "exe", "dll", "com", "scr", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta",
  "msi", "msp", "jar", "lnk", "reg", "cpl", "sh", "app", "apk",
])

const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  md: "text/markdown",
  eml: "message/rfc822",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  msg: "application/vnd.ms-outlook",
  gz: "application/gzip",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  msu: "application/octet-stream",
  cab: "application/vnd.ms-cab-compressed",
  deb: "application/vnd.debian.binary-package",
  rpm: "application/x-rpm",
}

export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name)
  return m ? m[1].toLowerCase() : ""
}

export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file"
  const clean = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^\.+/, "").trim()
  return (clean || "file").slice(0, 200)
}

function startsWith(buf: Buffer, bytes: number[], offset = 0) {
  return bytes.every((b, i) => buf[offset + i] === b)
}

function looksLikeText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 4096)
  if (sample.includes(0)) return false
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample.length === buf.length ? sample : sample.subarray(0, sample.length - 4))
    return true
  } catch {
    return false
  }
}

export type Sniffed = { mime: string; kind: "document" | "image" | "archive" | "text" | "executable" | "package" | "unknown" }

export function sniff(buf: Buffer, fileName: string): Sniffed {
  const ext = extensionOf(fileName)
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return { mime: "application/pdf", kind: "document" }
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47])) return { mime: "image/png", kind: "image" }
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", kind: "image" }
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return { mime: "image/gif", kind: "image" }
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return { mime: "image/webp", kind: "image" }
  if (startsWith(buf, [0x4d, 0x5a])) return { mime: "application/x-msdownload", kind: "executable" }
  if (startsWith(buf, [0x7f, 0x45, 0x4c, 0x46])) return { mime: "application/x-executable", kind: "executable" }
  if (startsWith(buf, [0x4d, 0x53, 0x43, 0x46])) return { mime: "application/vnd.ms-cab-compressed", kind: "package" }
  if (startsWith(buf, [0xed, 0xab, 0xee, 0xdb])) return { mime: "application/x-rpm", kind: "package" }
  if (buf.subarray(0, 21).toString("latin1") === "!<arch>\ndebian-binary") return { mime: "application/vnd.debian.binary-package", kind: "package" }
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06])) {
    if (["docx", "xlsx", "pptx", "zip"].includes(ext)) return { mime: EXT_MIME[ext], kind: ext === "zip" ? "archive" : "document" }
    if (ext === "jar" || ext === "apk") return { mime: "application/java-archive", kind: "executable" }
    return { mime: "application/zip", kind: "archive" }
  }
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    if (ext === "msi" || ext === "msp") return { mime: "application/x-msi", kind: "package" }
    if (["doc", "xls", "ppt", "msg"].includes(ext)) return { mime: EXT_MIME[ext], kind: "document" }
    return { mime: "application/x-ole-storage", kind: "document" }
  }
  if (startsWith(buf, [0x1f, 0x8b])) return { mime: "application/gzip", kind: "archive" }
  if (startsWith(buf, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { mime: "application/x-7z-compressed", kind: "archive" }
  if (startsWith(buf, [0x52, 0x61, 0x72, 0x21])) return { mime: "application/vnd.rar", kind: "archive" }
  if (looksLikeText(buf)) {
    if (buf.subarray(0, 2).toString() === "#!") return { mime: "text/plain", kind: "executable" }
    const textMime = ["csv", "json", "xml", "md", "eml", "log", "txt"].includes(ext) ? EXT_MIME[ext] : "text/plain"
    return { mime: textMime, kind: "text" }
  }
  return { mime: "application/octet-stream", kind: "unknown" }
}

/** Whether a ticket/KB attachment is acceptable (patch packages use their own rule). */
export function attachmentProblem(sniffed: Sniffed, fileName: string): string | null {
  const ext = extensionOf(fileName)
  if (EXECUTABLE_EXT.has(ext) || sniffed.kind === "executable" || sniffed.kind === "package") {
    return "Programs and scripts cannot be attached. Zip the file or share a link instead."
  }
  return null
}

const PACKAGE_EXT = new Set(["msu", "cab", "msi", "exe", "deb", "rpm"])
export function packageProblem(fileName: string): string | null {
  return PACKAGE_EXT.has(extensionOf(fileName)) ? null : "Upload a .msu, .cab, .msi, .exe, .deb or .rpm package"
}

/** Types that may be shown inline in the browser (everything else downloads). */
export function inlineSafe(mime: string): boolean {
  return ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"].includes(mime)
}
