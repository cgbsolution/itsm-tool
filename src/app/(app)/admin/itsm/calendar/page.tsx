import { requirePermission } from "@/lib/auth/session"
import { loadTenantSettings } from "@/lib/itsm/config"
import { formatDate } from "@/lib/format"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, Field, PageHeader } from "@/components/ui"
import { ItsmTabs } from "../tabs"
import { saveCalendarAction } from "../actions"

export const metadata = { title: "Calendar & ticket behaviour" }

const DAYS = [
  [1, "Monday"],
  [2, "Tuesday"],
  [3, "Wednesday"],
  [4, "Thursday"],
  [5, "Friday"],
  [6, "Saturday"],
  [0, "Sunday"],
] as const

const COMMON_ZONES = [
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Africa/Johannesburg",
]

export default async function CalendarPage() {
  const actor = await requirePermission("admin.itsm")
  const s = await loadTenantSettings(actor.tenantId)
  const upcoming = s.holidays.filter((h) => h >= new Date().toISOString().slice(0, 10)).slice(0, 5)
  return (
    <>
      <PageHeader title="ITSM settings" subtitle="Working calendar and ticket behaviour" back={{ href: "/admin/itsm", label: "ITSM settings" }} />
      <ItsmTabs active="calendar" />
      <ActionForm action={saveCalendarAction} className="max-w-4xl space-y-4">
        <Card title="Working calendar">
          <p className="mb-3 text-sm text-slate-500">
            SLA policies set to “business hours only” count time only inside these hours. Times on screens and in emails are shown in this time zone. Changes apply to clocks
            that start after you save.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Time zone" htmlFor="timezone" required hint="An IANA time zone name, such as Europe/London or Asia/Kolkata">
              <input id="timezone" name="timezone" list="tz-list" className="input" required maxLength={64} defaultValue={s.timezone} />
              <datalist id="tz-list">
                {COMMON_ZONES.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Work starts" htmlFor="workStart" required>
                <input id="workStart" name="workStart" type="time" className="input" required defaultValue={s.work_start} />
              </Field>
              <Field label="Work ends" htmlFor="workEnd" required>
                <input id="workEnd" name="workEnd" type="time" className="input" required defaultValue={s.work_end} />
              </Field>
            </div>
            <fieldset className="sm:col-span-2">
              <legend className="label">Work days</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {DAYS.map(([d, name]) => (
                  <label key={d} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" name="workDays" value={d} defaultChecked={s.work_days.includes(d)} /> {name}
                  </label>
                ))}
              </div>
            </fieldset>
            <Field
              label="Holidays"
              htmlFor="holidays"
              className="sm:col-span-2"
              hint={
                <>
                  One date per line as YYYY-MM-DD. You may add a name after the date (for example “2026-12-25 Christmas Day”), but only the date is kept.
                  {upcoming.length > 0 && <> Next: {upcoming.map((h) => formatDate(h)).join(", ")}.</>}
                </>
              }
            >
              <textarea id="holidays" name="holidays" className="input font-mono" rows={8} defaultValue={s.holidays.join("\n")} placeholder={"2026-12-25 Christmas Day\n2027-01-01 New Year"} />
            </Field>
          </div>
        </Card>

        <Card title="Ticket behaviour">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Longest hold" htmlFor="holdMaxHours" required hint="The longest an engineer can put a ticket on hold, in hours (1 to 8760). It resumes by itself after the chosen time.">
              <input id="holdMaxHours" name="holdMaxHours" type="number" min={1} max={8760} className="input" required defaultValue={s.hold_max_hours} />
            </Field>
            <Field label="Reopen window" htmlFor="reopenWindowDays" required hint="Days after resolution during which the requester can reopen (0 to 365)">
              <input id="reopenWindowDays" name="reopenWindowDays" type="number" min={0} max={365} className="input" required defaultValue={s.reopen_window_days} />
            </Field>
            <Field label="Auto-close resolved" htmlFor="autoCloseResolvedDays" required hint="Days after which resolved tickets close automatically (0 = never)">
              <input id="autoCloseResolvedDays" name="autoCloseResolvedDays" type="number" min={0} max={365} className="input" required defaultValue={s.auto_close_resolved_days} />
            </Field>
          </div>
          <label className="mt-4 flex items-start gap-2 text-sm">
            <input type="checkbox" name="strictAssignment" defaultChecked={s.strict_assignment} className="mt-0.5" />
            <span>
              <span className="font-medium">Strict assignment</span>
              <span className="block text-slate-500">
                Only the assignee works a ticket: updates it, changes its status or resolves it. Other engineers can still add internal notes or pick up
                unassigned tickets, and people with “Assign and transfer any ticket” can act on any ticket. Turn this off to let any engineer work any ticket.
              </span>
            </span>
          </label>
        </Card>
        <SubmitButton>Save</SubmitButton>
      </ActionForm>
    </>
  )
}
