"use client"
/** Client bits of the endpoint pages: copy buttons, the one-time token panel, select-all checkboxes. */
import { startTransition, useActionState, useRef, useState, type ReactNode } from "react"
import type { FormState } from "@/lib/actions"
import { installCommands } from "@/lib/endpoints/vocab"

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="btn btn-sm shrink-0"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          // clipboard blocked (http): select the text instead
          const ta = document.createElement("textarea")
          ta.value = text
          document.body.appendChild(ta)
          ta.select()
          document.execCommand("copy")
          ta.remove()
        }
        setDone(true)
        setTimeout(() => setDone(false), 1500)
      }}
    >
      {done ? "Copied" : label}
    </button>
  )
}

/** A command line with a copy button. */
export function CommandLine({ command }: { command: string }) {
  return (
    <div className="flex items-start gap-2">
      <code className="block min-w-0 flex-1 rounded-md bg-slate-900 px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap text-slate-100">{command}</code>
      <CopyButton text={command} />
    </div>
  )
}

type Action = (prev: FormState, fd: FormData) => Promise<FormState>

/**
 * Creates an enrolment token. The action returns the token as `ok`; it is
 * shown once with ready-to-copy install commands and is not stored anywhere.
 */
export function TokenCreateForm({ action, serverUrl, children }: { action: Action; serverUrl: string; children: ReactNode }) {
  const [state, dispatch, pending] = useActionState(action, null)
  const ref = useRef<HTMLFormElement>(null)
  const token = state?.ok && state.ok.startsWith("enr_") ? state.ok : null
  const cmds = token ? installCommands(serverUrl, token) : null
  return (
    <div className="space-y-4">
      <form
        ref={ref}
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          const fd = new FormData(e.currentTarget)
          startTransition(() => dispatch(fd))
        }}
      >
        <fieldset disabled={pending} className="contents">
          {children}
        </fieldset>
        {state?.error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">
            {state.error}
          </p>
        )}
      </form>
      {token && cmds && (
        <div role="status" className="space-y-3 rounded-md bg-emerald-50 p-3 ring-1 ring-emerald-200">
          <p className="text-sm font-medium text-emerald-800">Token created. Copy it now: it is shown only once.</p>
          <CommandLine command={token} />
          <div>
            <div className="mb-1 text-xs font-medium text-slate-600">Windows (administrator PowerShell, in the folder with itsm-agent.ps1)</div>
            <CommandLine command={cmds.windows} />
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-slate-600">Linux (in the folder with itsm-agent.py)</div>
            <CommandLine command={cmds.linux} />
          </div>
        </div>
      )}
    </div>
  )
}

/** Header checkbox that ticks every checkbox called `name` in the same form. */
export function CheckAll({ name, label = "Select all" }: { name: string; label?: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      onChange={(e) => {
        const form = e.currentTarget.form
        if (!form) return
        for (const el of Array.from(form.querySelectorAll<HTMLInputElement>(`input[type=checkbox][name="${name}"]`))) el.checked = e.currentTarget.checked
      }}
    />
  )
}
