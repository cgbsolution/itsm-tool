"use client"
/** Small client components: forms bound to server actions, flash messages, notification bell. */
import { startTransition, useActionState, useEffect, useRef, useState, type ReactNode } from "react"
import { useFormStatus } from "react-dom"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import type { FormState } from "@/lib/actions"

type Action = (prev: FormState, fd: FormData) => Promise<FormState>

/**
 * A form for a server action. Shows the action's error/ok message, keeps what
 * the user typed when validation fails, and disables inputs while pending.
 */
export function ActionForm({
  action,
  children,
  className,
  confirm,
  resetOnSuccess,
  id,
}: {
  action: Action
  children: ReactNode
  className?: string
  confirm?: string
  resetOnSuccess?: boolean
  id?: string
}) {
  const [state, dispatch, pending] = useActionState(action, null)
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (state?.ok && resetOnSuccess) ref.current?.reset()
  }, [state, resetOnSuccess])
  return (
    <form
      id={id}
      ref={ref}
      className={className}
      onSubmit={(e) => {
        e.preventDefault()
        if (confirm && !window.confirm(confirm)) return
        const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null
        const fd = new FormData(e.currentTarget, submitter)
        startTransition(() => dispatch(fd))
      }}
    >
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
      {state?.error && (
        <p role="alert" className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p role="status" className="mt-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 ring-1 ring-emerald-200">
          {state.ok}
        </p>
      )}
    </form>
  )
}

export function SubmitButton({ children, className = "btn btn-primary", name, value, pendingText }: { children: ReactNode; className?: string; name?: string; value?: string; pendingText?: string }) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" className={className} name={name} value={value} disabled={pending}>
      {pending && pendingText ? pendingText : children}
    </button>
  )
}

/** Shows ?flash= / ?error= from the URL once, then removes it. */
export function FlashFromUrl() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const flash = params.get("flash")
  const error = params.get("error")
  const [shown, setShown] = useState<{ flash: string | null; error: string | null }>({ flash: null, error: null })
  useEffect(() => {
    if (!flash && !error) return
    setShown({ flash, error })
    const next = new URLSearchParams(params.toString())
    next.delete("flash")
    next.delete("error")
    const s = next.toString()
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false })
  }, [flash, error, params, pathname, router])
  if (!shown.flash && !shown.error) return null
  return (
    <div
      role="status"
      className={`mb-4 flex items-start justify-between gap-3 rounded-md px-3 py-2 text-sm ring-1 ${
        shown.error ? "bg-red-50 text-red-700 ring-red-200" : "bg-emerald-50 text-emerald-700 ring-emerald-200"
      }`}
    >
      <span>{shown.error ?? shown.flash}</span>
      <button type="button" className="text-xs opacity-70 hover:opacity-100" onClick={() => setShown({ flash: null, error: null })}>
        Dismiss
      </button>
    </div>
  )
}

export function NotificationBell({ initial }: { initial: number }) {
  const [count, setCount] = useState(initial)
  useEffect(() => {
    let stop = false
    const tick = async () => {
      try {
        const res = await fetch("/api/notifications/count", { cache: "no-store" })
        if (res.ok && !stop) setCount((await res.json()).unread ?? 0)
      } catch {
        // offline: keep the last count
      }
    }
    const id = setInterval(tick, 30_000)
    return () => {
      stop = true
      clearInterval(id)
    }
  }, [])
  return (
    <Link href="/notifications" className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-600 no-underline hover:bg-slate-100 hover:no-underline" aria-label={`Notifications (${count} unread)`}>
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
        <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {count > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] leading-4 font-semibold text-white">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  )
}

/** Category → sub-category pair of selects. */
export function CategoryPicker({
  categories,
  type,
  defaultValue,
  name = "categoryId",
}: {
  categories: { id: string; parent_id: string | null; name: string; ticket_types: string[] | null; is_active: boolean }[]
  type: string
  defaultValue?: string | null
  name?: string
}) {
  const offered = categories.filter((c) => c.is_active && (!c.ticket_types || c.ticket_types.includes(type)))
  const parents = offered.filter((c) => !c.parent_id)
  const initial = categories.find((c) => c.id === defaultValue)
  const [parent, setParent] = useState<string>(initial ? initial.parent_id ?? initial.id : "")
  const [child, setChild] = useState<string>(initial?.parent_id ? initial.id : "")
  const subs = categories.filter((c) => c.parent_id === parent && c.is_active)
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label className="label" htmlFor="cat-parent">Category</label>
        <select id="cat-parent" className="input" value={parent} onChange={(e) => { setParent(e.target.value); setChild("") }}>
          <option value="">— Choose —</option>
          {parents.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="cat-child">Sub-category</label>
        <select id="cat-child" className="input" value={child} onChange={(e) => setChild(e.target.value)} disabled={!subs.length}>
          <option value="">{subs.length ? "— Choose —" : "—"}</option>
          {subs.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>
      <input type="hidden" name={name} value={child || parent} />
    </div>
  )
}

/** Impact × urgency with a live priority preview from the tenant's matrix. */
export function PriorityPicker({
  matrix,
  defaultImpact,
  defaultUrgency,
  defaultPriority,
  allowOverride,
}: {
  matrix: { impact: string; urgency: string; priority: string }[]
  defaultImpact?: string | null
  defaultUrgency?: string | null
  defaultPriority?: string | null
  allowOverride: boolean
}) {
  const [impact, setImpact] = useState(defaultImpact ?? "")
  const [urgency, setUrgency] = useState(defaultUrgency ?? "")
  const fromMatrix = matrix.find((m) => m.impact === impact && m.urgency === urgency)?.priority
  const labels: Record<string, string> = { critical: "P1 · Critical", high: "P2 · High", medium: "P3 · Medium", low: "P4 · Low" }
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div>
        <label className="label" htmlFor="impact">Impact</label>
        <select id="impact" name="impact" className="input" value={impact} onChange={(e) => setImpact(e.target.value)}>
          <option value="">—</option>
          <option value="high">High: many people or a site</option>
          <option value="medium">Medium: a team</option>
          <option value="low">Low: one person</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="urgency">Urgency</label>
        <select id="urgency" name="urgency" className="input" value={urgency} onChange={(e) => setUrgency(e.target.value)}>
          <option value="">—</option>
          <option value="high">High: work has stopped</option>
          <option value="medium">Medium: work is slowed</option>
          <option value="low">Low: can wait</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="priority">Priority</label>
        {allowOverride ? (
          <select id="priority" name="priority" className="input" defaultValue={defaultPriority ?? ""}>
            <option value="">{fromMatrix ? `From matrix: ${labels[fromMatrix]}` : "From impact × urgency"}</option>
            {Object.entries(labels).map(([k, v]) => (
              <option key={k} value={k}>Override: {v}</option>
            ))}
          </select>
        ) : (
          <div className="input bg-slate-50">{fromMatrix ? labels[fromMatrix] : "Set impact and urgency"}</div>
        )}
      </div>
    </div>
  )
}

/** Shows a group of fields only when a select / radio has a value. */
export function Reveal({ when, children }: { when: string; children: ReactNode }) {
  const [value, setValue] = useState("")
  useEffect(() => {
    const el = document.querySelector<HTMLSelectElement | HTMLInputElement>(`[name="${when.split("=")[0]}"]`)
    if (!el) return
    const update = () => setValue(el.value)
    update()
    el.addEventListener("change", update)
    return () => el.removeEventListener("change", update)
  }, [when])
  const [, expected] = when.split("=")
  return value === expected ? <>{children}</> : null
}
