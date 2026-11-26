/** Display formatting (server and client). */

export function formatDateTime(d: Date | string | null | undefined, timeZone = "UTC"): string {
  if (!d) return "—"
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(d))
  } catch {
    return new Date(d).toISOString()
  }
}

export function formatDate(d: Date | string | null | undefined, timeZone = "UTC"): string {
  if (!d) return "—"
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split("-").map(Number)
    return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, day)))
  }
  return new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "medium" }).format(new Date(d))
}

export function timeAgo(d: Date | string | null | undefined, now = Date.now()): string {
  if (!d) return "—"
  const diff = Math.round((now - new Date(d).getTime()) / 1000)
  const future = diff < 0
  const s = Math.abs(diff)
  const unit =
    s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : s < 86400 * 30 ? `${Math.floor(s / 86400)} d` : `${Math.floor(s / (86400 * 30))} mo`
  return future ? `in ${unit}` : s < 30 ? "just now" : `${unit} ago`
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—"
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function pct(part: number, whole: number): string {
  if (!whole) return "—"
  return `${Math.round((part / whole) * 100)}%`
}

export function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`
}
