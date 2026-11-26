/** Server-rendered UI primitives (no client JavaScript). */
import Link from "next/link"
import type { ReactNode } from "react"
import { STATUS_LABELS, STATE_CATEGORY, type Status } from "@/lib/itsm/workflow"
import { PRIORITY_LABELS, TICKET_TYPE_LABELS, humanize, type Priority, type TicketType } from "@/lib/itsm/vocab"
import { formatDateTime, timeAgo } from "@/lib/format"

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ")
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {back && (
          <Link href={back.href} className="mb-1 inline-block text-xs text-slate-500 hover:text-slate-700">
            ← {back.label}
          </Link>
        )}
        <h1 className="truncate">{title}</h1>
        {subtitle && <div className="mt-0.5 text-sm text-slate-500">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Card({ title, actions, children, className, bodyClassName }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cx("card", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
          {title && <h2 className="text-sm">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx("card-body", bodyClassName)}>{children}</div>
    </section>
  )
}

const TONES = {
  gray: "bg-slate-100 text-slate-700",
  blue: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
  green: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-1 ring-amber-200",
  red: "bg-red-50 text-red-700 ring-1 ring-red-200",
  purple: "bg-violet-50 text-violet-700 ring-1 ring-violet-200",
  slate: "bg-slate-800 text-white",
} as const
export type Tone = keyof typeof TONES

export function Badge({ tone = "gray", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={cx("badge", TONES[tone])} title={title}>
      {children}
    </span>
  )
}

export function StatusBadge({ status }: { status: string }) {
  const cat = STATE_CATEGORY[status as Status]
  const tone: Tone =
    status === "new" || status === "draft"
      ? "blue"
      : cat === "paused"
        ? "amber"
        : cat === "resolved"
          ? "green"
          : status === "closed"
            ? "gray"
            : status === "rejected" || status === "cancelled"
              ? "red"
              : "purple"
  return <Badge tone={tone}>{STATUS_LABELS[status as Status] ?? humanize(status)}</Badge>
}

export function PriorityBadge({ priority }: { priority: string }) {
  const tone: Tone = priority === "critical" ? "red" : priority === "high" ? "amber" : priority === "medium" ? "blue" : "gray"
  return <Badge tone={tone}>{PRIORITY_LABELS[priority as Priority] ?? priority}</Badge>
}

export function TypeBadge({ type }: { type: string }) {
  return <Badge tone="slate">{TICKET_TYPE_LABELS[type as TicketType] ?? type}</Badge>
}

export function SlaBadge({ due, breached, active, timeZone }: { due: Date | string | null; breached: boolean; active: boolean; timeZone: string }) {
  if (breached) return <Badge tone="red" title={due ? `Due ${formatDateTime(due, timeZone)}` : undefined}>SLA breached</Badge>
  if (!due || !active) return <span className="text-xs text-slate-400">—</span>
  const ms = new Date(due).getTime() - Date.now()
  const tone: Tone = ms < 0 ? "red" : ms < 2 * 3600_000 ? "amber" : "gray"
  return (
    <Badge tone={tone} title={`Due ${formatDateTime(due, timeZone)}`}>
      {ms < 0 ? "overdue" : `due ${timeAgo(due)}`}
    </Badge>
  )
}

export function Field({ label, htmlFor, hint, children, className, required }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; children: ReactNode; className?: string; required?: boolean }) {
  return (
    <div className={className}>
      <label className="label" htmlFor={htmlFor}>
        {label}
        {required && <span className="text-red-600"> *</span>}
      </label>
      {children}
      {hint && <p className="hint">{hint}</p>}
    </div>
  )
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <p className="font-medium text-slate-700">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-slate-500">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Stat({ label, value, href, tone, sub }: { label: string; value: ReactNode; href?: string; tone?: "red" | "amber" | "green"; sub?: ReactNode }) {
  const color = tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-600" : tone === "green" ? "text-emerald-600" : "text-slate-900"
  const inner = (
    <div className="card card-body h-full transition-colors hover:border-slate-300">
      <div className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</div>
      <div className={cx("mt-1 text-2xl font-semibold", color)}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  )
  return href ? (
    <Link href={href} className="block text-inherit no-underline hover:no-underline">
      {inner}
    </Link>
  ) : (
    inner
  )
}

export function Tabs({ items }: { items: { href: string; label: ReactNode; active?: boolean }[] }) {
  return (
    <nav className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
      {items.map((it) => (
        <Link
          key={it.href}
          href={it.href}
          className={cx(
            "-mb-px border-b-2 px-3 py-2 text-sm no-underline hover:no-underline",
            it.active ? "border-brand font-medium text-slate-900" : "border-transparent text-slate-500 hover:text-slate-800"
          )}
        >
          {it.label}
        </Link>
      ))}
    </nav>
  )
}

export function Pagination({ page, pageSize, total, href }: { page: number; pageSize: number; total: number; href: (page: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (pages <= 1) return <p className="mt-3 text-xs text-slate-500">{total} result{total === 1 ? "" : "s"}</p>
  return (
    <div className="mt-3 flex items-center justify-between text-sm">
      <span className="text-xs text-slate-500">
        {total} results · page {page} of {pages}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link className="btn btn-sm" href={href(page - 1)}>
            Previous
          </Link>
        ) : (
          <span className="btn btn-sm opacity-40">Previous</span>
        )}
        {page < pages ? (
          <Link className="btn btn-sm" href={href(page + 1)}>
            Next
          </Link>
        ) : (
          <span className="btn btn-sm opacity-40">Next</span>
        )}
      </div>
    </div>
  )
}

export function KeyValues({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-slate-500">{k}</dt>
          <dd className="min-w-0 break-words text-slate-800">{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  )
}

export function When({ value, timeZone }: { value: Date | string | null | undefined; timeZone: string }) {
  if (!value) return <span className="text-slate-400">—</span>
  return (
    <time dateTime={new Date(value).toISOString()} title={formatDateTime(value, timeZone)}>
      {timeAgo(value)}
    </time>
  )
}

/** Query-string helper for filter links. */
export function qs(base: Record<string, string | number | undefined | null>, patch: Record<string, string | number | undefined | null> = {}): string {
  const merged = { ...base, ...patch }
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(merged)) if (v !== undefined && v !== null && v !== "") sp.set(k, String(v))
  const s = sp.toString()
  return s ? `?${s}` : ""
}
