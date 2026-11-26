import Link from "next/link"
import { notFound } from "next/navigation"
import { requireActor, can } from "@/lib/auth/session"
import { getTicketDetail, assignmentOptions } from "@/lib/itsm/queries"
import { AppError } from "@/lib/errors"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, KeyValues, PageHeader, PriorityBadge, StatusBadge, TypeBadge, When } from "@/components/ui"
import { formatDateTime, bytes } from "@/lib/format"
import { formatMinutes } from "@/lib/itsm/clock"
import { CHANGE_OUTCOMES, CHANGE_TYPE_LABELS, LINK_TYPES, LINK_TYPE_LABELS, RESOLUTION_CODES, TICKET_TYPE_LABELS, humanize, type ChangeType } from "@/lib/itsm/vocab"
import { STATUS_LABELS, type Status, type Transition } from "@/lib/itsm/workflow"
import {
  acquireAction, addTaskAction, assignAction, commentAction, deleteTicketAction, linkAction, linkCiAction, taskStatusAction,
  transitionAction, unlinkAction, unlinkCiAction, uploadAction, watchAction,
} from "../actions"

export async function generateMetadata({ params }: { params: Promise<{ number: string }> }) {
  return { title: (await params).number.toUpperCase() }
}

const ACTIVITY_LABEL: Record<string, string> = {
  created: "raised the ticket",
  acquired: "picked it up",
  assigned: "changed the assignment",
  updated: "updated fields",
  status: "changed the status",
  linked: "linked a ticket",
  unlinked: "removed a link",
  ci_linked: "linked a configuration item",
  ci_unlinked: "removed a configuration item",
  approval_requested: "requested approval",
  approval_approved: "approved",
  approval_rejected: "rejected",
  sla_breached: "SLA breached",
  sla_warning: "SLA warning",
  task_added: "added a task",
  task_done: "completed a task",
  task_open: "reopened a task",
  task_cancelled: "cancelled a task",
}

function TransitionForm({ tr, ticketId, number, version, holdMax, isProblem, rootCause, workaround }: {
  tr: Transition; ticketId: string; number: string; version: number; holdMax: number; isProblem: boolean; rootCause: string | null; workaround: string | null
}) {
  const action = transitionAction.bind(null, ticketId, number)
  const req = new Set(tr.requires ?? [])
  const btnClass = tr.tone === "primary" ? "btn btn-primary" : tr.tone === "danger" ? "btn btn-danger" : "btn"
  const hidden = (
    <>
      <input type="hidden" name="action" value={tr.action} />
      <input type="hidden" name="version" value={version} />
    </>
  )
  const needsForm = req.has("hold") || req.has("resolution") || req.has("comment") || req.has("workaround") || req.has("root_cause") || req.has("outcome")
  if (!needsForm) {
    return (
      <ActionForm action={action}>
        {hidden}
        <SubmitButton className={`${btnClass} w-full`}>{tr.label}</SubmitButton>
      </ActionForm>
    )
  }
  const hours = [4, 8, 24, 48, 72, 168, 336, 720].filter((h) => h <= holdMax)
  return (
    <details className="group rounded-md border border-slate-200">
      <summary className={`${btnClass} w-full list-none`}>{tr.label}…</summary>
      <ActionForm action={action} className="space-y-2 p-3">
        {hidden}
        {req.has("hold") && (
          <>
            <select name="holdReason" className="input" required defaultValue="">
              <option value="" disabled>Why is it on hold?</option>
              <option>Awaiting requester</option>
              <option>Awaiting vendor</option>
              <option>Awaiting parts</option>
              <option>Awaiting change</option>
              <option>Scheduled for later</option>
            </select>
            <select name="holdHours" className="input" defaultValue={String(Math.min(24, holdMax))}>
              {hours.map((h) => (
                <option key={h} value={h}>For {h < 48 ? `${h} hours` : `${h / 24} days`} (then resumes)</option>
              ))}
            </select>
          </>
        )}
        {req.has("resolution") && !isProblem && (
          <>
            <select name="resolutionCode" className="input" required defaultValue="">
              <option value="" disabled>Resolution code</option>
              {RESOLUTION_CODES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <textarea name="resolutionNotes" className="input" rows={3} required placeholder="What fixed it? The requester sees this." />
          </>
        )}
        {(req.has("root_cause") || (req.has("resolution") && isProblem)) && (
          <textarea name="rootCause" className="input" rows={3} required defaultValue={rootCause ?? ""} placeholder="Root cause" />
        )}
        {req.has("workaround") && <textarea name="workaround" className="input" rows={3} required defaultValue={workaround ?? ""} placeholder="Workaround" />}
        {req.has("outcome") && (
          <select name="outcome" className="input" required defaultValue="">
            <option value="" disabled>Outcome</option>
            {CHANGE_OUTCOMES.map((o) => (
              <option key={o} value={o}>{humanize(o)}</option>
            ))}
          </select>
        )}
        {req.has("comment") && <textarea name="comment" className="input" rows={2} required placeholder="Reason" />}
        <SubmitButton className={btnClass}>{tr.label}</SubmitButton>
      </ActionForm>
    </details>
  )
}

export default async function TicketPage({ params }: { params: Promise<{ number: string }> }) {
  const actor = await requireActor()
  const { number } = await params
  let d
  try {
    d = await getTicketDetail(actor, decodeURIComponent(number))
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  const { ticket: t, access, config } = d
  const tz = actor.tenant.timezone
  const options = access.canAssign || access.canWork ? await assignmentOptions(actor.tenantId) : { people: [], groups: [] }
  const watching = d.watchers.some((w) => w.user_id === actor.id)
  const id = t.id
  const num = t.number

  return (
    <>
      <PageHeader
        back={{ href: t.ticket_type === "problem" || t.ticket_type === "change" ? `/tickets?type=${t.ticket_type}` : "/tickets", label: "Tickets" }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-base text-slate-500">{num}</span>
            <span>{t.subject}</span>
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <TypeBadge type={t.ticket_type} />
            <StatusBadge status={t.status} />
            <PriorityBadge priority={t.priority} />
            {t.known_error && <Badge tone="purple">Known error</Badge>}
            {t.change_type && <Badge tone="blue">{CHANGE_TYPE_LABELS[t.change_type as ChangeType]}</Badge>}
            <span className="text-xs">
              Raised <When value={t.created_at} timeZone={tz} /> by {t.requester_full_name ?? t.requester_name ?? "unknown"} via {t.source}
            </span>
          </span>
        }
        actions={
          <>
            {access.canWork && (
              <Link className="btn" href={`/tickets/${num}/edit`}>
                Edit
              </Link>
            )}
            <ActionForm action={watchAction.bind(null, id, num, !watching)}>
              <SubmitButton className="btn">{watching ? "Unwatch" : "Watch"}</SubmitButton>
            </ActionForm>
            {access.canDelete && (
              <ActionForm action={deleteTicketAction.bind(null, id)} confirm={`Delete ${num} permanently? This is recorded in the audit log.`}>
                <SubmitButton className="btn btn-danger">Delete</SubmitButton>
              </ActionForm>
            )}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-4">
          <Card title="Description">
            {t.description ? <div className="prose-plain">{t.description}</div> : <p className="muted text-sm">No description.</p>}
            {Object.keys(t.form_data ?? {}).length > 0 && (
              <div className="mt-4 border-t border-slate-100 pt-3">
                <h3 className="mb-2 text-xs font-semibold text-slate-500 uppercase">{t.catalog_item_name ?? "Request details"}</h3>
                <KeyValues
                  items={Object.entries(t.form_data).map(([k, v]) => [
                    (t.catalog_form_fields ?? []).find((f) => f.key === k)?.label ?? humanize(k),
                    Array.isArray(v) ? v.join(", ") : v === true ? "Yes" : v === false ? "No" : String(v),
                  ])}
                />
              </div>
            )}
            {config.customFields.length > 0 && Object.keys(t.custom ?? {}).length > 0 && (
              <div className="mt-4 border-t border-slate-100 pt-3">
                <KeyValues
                  items={config.customFields
                    .filter((f) => t.custom[f.key] !== undefined)
                    .map((f) => [f.label, Array.isArray(t.custom[f.key]) ? (t.custom[f.key] as string[]).join(", ") : String(t.custom[f.key] === true ? "Yes" : t.custom[f.key] === false ? "No" : t.custom[f.key])])}
                />
              </div>
            )}
          </Card>

          {(t.resolution_notes || t.close_comment) && (
            <Card title="Resolution">
              <KeyValues
                items={[
                  ["Code", t.resolution_code],
                  ["Notes", <span key="n" className="prose-plain">{t.resolution_notes}</span>],
                  ["Resolved", t.resolved_at ? formatDateTime(t.resolved_at, tz) : null],
                  ...(t.close_comment ? ([["Closing note", t.close_comment]] as [string, string][]) : []),
                ]}
              />
            </Card>
          )}

          {t.ticket_type === "problem" && (
            <Card title="Problem analysis">
              <KeyValues
                items={[
                  ["Workaround", <span key="w" className="prose-plain">{t.workaround ?? "—"}</span>],
                  ["Root cause", <span key="r" className="prose-plain">{t.root_cause ?? "—"}</span>],
                ]}
              />
            </Card>
          )}

          {t.ticket_type === "change" && (
            <Card title="Change plan">
              <KeyValues
                items={[
                  ["Planned", t.planned_start ? `${formatDateTime(t.planned_start, tz)} → ${formatDateTime(t.planned_end, tz)}` : "Not scheduled"],
                  ["Actual", t.actual_start ? `${formatDateTime(t.actual_start, tz)} → ${t.actual_end ? formatDateTime(t.actual_end, tz) : "in progress"}` : "—"],
                  ["Risk", t.risk ? humanize(t.risk) : "—"],
                  ["Approval board", t.cab_group_name ?? "Default CAB"],
                  ["Outcome", t.change_outcome ? humanize(t.change_outcome) : "—"],
                  ["Reason", <span key="j" className="prose-plain">{t.justification ?? "—"}</span>],
                  ["Implementation", <span key="i" className="prose-plain">{t.implementation_plan ?? "—"}</span>],
                  ["Back-out", <span key="b" className="prose-plain">{t.backout_plan ?? "—"}</span>],
                  ["Testing", <span key="t" className="prose-plain">{t.test_plan ?? "—"}</span>],
                ]}
              />
            </Card>
          )}

          <Card title={`Conversation (${d.comments.length})`}>
            <ol className="space-y-3">
              {d.comments.map((c) => (
                <li
                  key={c.id}
                  className={`rounded-md border p-3 ${c.is_internal ? "border-amber-200 bg-amber-50" : c.author_id === t.requester_id ? "border-slate-200 bg-white" : "border-blue-100 bg-blue-50/40"}`}
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="font-medium text-slate-700">{c.author_name ?? c.author_label ?? "System"}</span>
                    {c.is_internal && <Badge tone="amber">Internal note</Badge>}
                    {c.source === "email" && <Badge>email</Badge>}
                    {c.source === "migration" && <Badge>imported</Badge>}
                    <span title={formatDateTime(c.created_at, tz)}>
                      <When value={c.created_at} timeZone={tz} />
                    </span>
                  </div>
                  <div className="prose-plain">{c.body}</div>
                </li>
              ))}
              {d.comments.length === 0 && <li className="text-sm text-slate-500">No replies yet.</li>}
            </ol>
            {(access.canCommentPublic || access.canCommentInternal) && (
              <ActionForm action={commentAction.bind(null, id, num)} resetOnSuccess className="mt-4 space-y-2 border-t border-slate-100 pt-4">
                <textarea name="body" rows={3} required className="input" placeholder={access.canCommentPublic ? "Write a reply…" : "Write an internal note…"} />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    {access.canCommentInternal && access.canCommentPublic && (
                      <label className="flex items-center gap-1.5 text-sm text-slate-600">
                        <input type="checkbox" name="internal" /> Internal note (IT team only)
                      </label>
                    )}
                    {!access.canCommentPublic && <input type="hidden" name="internal" value="on" />}
                    <input type="file" name="files" multiple className="text-xs" />
                  </div>
                  <SubmitButton>Send</SubmitButton>
                </div>
              </ActionForm>
            )}
          </Card>

          {access.isStaff && d.activity.length > 0 && (
            <Card title="History">
              <ol className="space-y-1.5 text-sm">
                {d.activity.map((a) => {
                  const det = (a.details ?? {}) as Record<string, unknown>
                  let extra = ""
                  if (a.action === "status") extra = `${STATUS_LABELS[det.from as Status] ?? det.from} → ${STATUS_LABELS[det.to as Status] ?? det.to}${det.comment ? ` · ${det.comment}` : ""}`
                  else if (a.action === "updated" && det.changes) extra = Object.keys(det.changes as object).join(", ")
                  else if (a.action === "linked") extra = `${det.to} (${det.type})`
                  else if (a.action === "ci_linked") extra = String(det.ci ?? "")
                  else if (a.action.startsWith("sla_")) extra = String(det.kind ?? "")
                  else if (a.action.startsWith("task_")) extra = String(det.title ?? "")
                  else if (a.action === "assigned" && det.note) extra = String(det.note)
                  return (
                    <li key={a.id} className="flex gap-2">
                      <span className="w-28 shrink-0 text-xs text-slate-400" title={formatDateTime(a.created_at, tz)}>
                        <When value={a.created_at} timeZone={tz} />
                      </span>
                      <span>
                        <span className="font-medium">{a.actor_name ?? "System"}</span> {ACTIVITY_LABEL[a.action] ?? a.action}
                        {extra && <span className="text-slate-500"> — {extra}</span>}
                      </span>
                    </li>
                  )
                })}
              </ol>
            </Card>
          )}
        </div>

        <aside className="space-y-4">
          {(access.canAcquire || access.transitions.length > 0) && (
            <Card title="Actions">
              <div className="space-y-2">
                {access.canAcquire && (
                  <ActionForm action={acquireAction.bind(null, id, num)}>
                    <SubmitButton className="btn btn-primary w-full">Pick up (assign to me)</SubmitButton>
                  </ActionForm>
                )}
                {access.transitions.map((tr) => (
                  <TransitionForm
                    key={tr.action}
                    tr={tr}
                    ticketId={id}
                    number={num}
                    version={t.version}
                    holdMax={config.settings.hold_max_hours}
                    isProblem={t.ticket_type === "problem"}
                    rootCause={t.root_cause}
                    workaround={t.workaround}
                  />
                ))}
              </div>
              {t.status === "on_hold" && t.hold_until && (
                <p className="hint">
                  On hold ({t.hold_reason}) until {formatDateTime(t.hold_until, tz)}; it resumes automatically.
                </p>
              )}
            </Card>
          )}

          <Card title="Details">
            <KeyValues
              items={[
                ["Requester", t.requester_full_name ?? t.requester_name ?? "—"],
                ...(access.isStaff && t.requester_email ? ([["Email", t.requester_email]] as [string, string][]) : []),
                ["Assigned to", t.assignee_name ?? <Badge key="u" tone="amber">Unassigned</Badge>],
                ["Group", t.group_name ?? "—"],
                ["Category", t.category ? `${t.category}${t.sub_category ? ` › ${t.sub_category}` : ""}` : "—"],
                ["Impact / urgency", t.impact || t.urgency ? `${humanize(t.impact) || "—"} / ${humanize(t.urgency) || "—"}` : "—"],
                ...(t.contact ? ([["Contact", t.contact]] as [string, string][]) : []),
                ...(t.location ? ([["Location", t.location]] as [string, string][]) : []),
                ...(t.organization_name ? ([["Organisation", t.organization_name]] as [string, string][]) : []),
                ["Created", formatDateTime(t.created_at, tz)],
                ["Updated", formatDateTime(t.updated_at, tz)],
              ]}
            />
          </Card>

          {d.clocks.length > 0 && (
            <Card title="SLA">
              <ul className="space-y-2 text-sm">
                {d.clocks.map((c) => {
                  const label = { response: "Response", resolution: "Resolution", ola_response: "Group response (OLA)", ola_resolution: "Group resolution (OLA)" }[c.kind]
                  const tone = c.breached ? "red" : c.status === "met" ? "green" : c.status === "paused" ? "amber" : "blue"
                  return (
                    <li key={c.id} className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-medium">{label}{c.group_name ? ` · ${c.group_name}` : ""}</div>
                        <div className="text-xs text-slate-500">
                          Target {formatMinutes(c.target_minutes)}{c.business_hours ? " (business hours)" : ""} · due {formatDateTime(c.due_at, tz)}
                        </div>
                      </div>
                      <Badge tone={tone}>{c.breached ? "breached" : c.status}</Badge>
                    </li>
                  )
                })}
              </ul>
            </Card>
          )}

          {d.approvals.length > 0 && (
            <Card title="Approvals" actions={<Link href="/approvals" className="text-xs">My approvals</Link>}>
              <ul className="space-y-2 text-sm">
                {d.approvals.map((a) => (
                  <li key={a.id}>
                    <div className="flex items-center justify-between gap-2">
                      <span>
                        Step {a.step}: {a.approver_name ?? a.group_name}
                      </span>
                      <Badge tone={a.status === "approved" ? "green" : a.status === "rejected" ? "red" : "amber"}>{a.status}</Badge>
                    </div>
                    {a.decided_by_name && (
                      <div className="text-xs text-slate-500">
                        {a.decided_by_name}, {formatDateTime(a.decided_at, tz)}
                        {a.comment ? ` — ${a.comment}` : ""}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {access.canAssign && (
            <Card title={t.assignee_id ? "Transfer" : "Assign"}>
              <ActionForm action={assignAction.bind(null, id, num)} className="space-y-2">
                <select name="groupId" defaultValue={t.assignment_group_id ?? ""} className="input" aria-label="Group">
                  <option value="">— No group —</option>
                  {options.groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
                <select name="assigneeId" defaultValue={t.assignee_id ?? ""} className="input" aria-label="Assignee">
                  <option value="">— Nobody —</option>
                  {options.people.map((p) => (
                    <option key={p.id} value={p.id}>{p.full_name || p.email}</option>
                  ))}
                </select>
                <input name="note" className="input" placeholder="Note for the new assignee (optional)" />
                <SubmitButton className="btn w-full">Save assignment</SubmitButton>
              </ActionForm>
            </Card>
          )}

          {(d.tasks.length > 0 || (access.canWork && (t.ticket_type === "change" || t.ticket_type === "service_request"))) && (
            <Card title="Tasks">
              <ul className="space-y-1.5 text-sm">
                {d.tasks.map((k) => (
                  <li key={k.id} className="flex items-center gap-2">
                    <ActionForm action={taskStatusAction.bind(null, id, num, k.id, k.status === "done" ? "open" : "done")}>
                      <button className={`h-4 w-4 rounded border ${k.status === "done" ? "border-emerald-500 bg-emerald-500" : "border-slate-300"}`} aria-label="Toggle task" />
                    </ActionForm>
                    <span className={k.status === "done" ? "text-slate-400 line-through" : ""}>{k.title}</span>
                    {k.assignee_name && <span className="ml-auto text-xs text-slate-400">{k.assignee_name}</span>}
                  </li>
                ))}
              </ul>
              {access.canWork && (
                <ActionForm action={addTaskAction.bind(null, id, num)} resetOnSuccess className="mt-2 flex gap-2">
                  <input name="title" className="input" placeholder="New task" required />
                  <SubmitButton className="btn">Add</SubmitButton>
                </ActionForm>
              )}
            </Card>
          )}

          <Card title="Linked records">
            <ul className="space-y-1.5 text-sm">
              {d.links.map((l) => (
                <li key={l.id} className="flex items-start justify-between gap-2">
                  <span>
                    <span className="text-xs text-slate-500">{l.direction === "out" ? LINK_TYPE_LABELS[l.link_type as keyof typeof LINK_TYPE_LABELS] : `Linked from (${l.link_type})`}</span>{" "}
                    <Link href={`/tickets/${l.other_number}`} className="font-mono text-xs">{l.other_number}</Link> {l.other_subject}
                  </span>
                  {access.canLink && (
                    <ActionForm action={unlinkAction.bind(null, id, num, l.id)}>
                      <button className="text-xs text-slate-400 hover:text-red-600" aria-label="Remove link">✕</button>
                    </ActionForm>
                  )}
                </li>
              ))}
              {d.links.length === 0 && <li className="text-slate-500">None</li>}
            </ul>
            {access.canLink && (
              <ActionForm action={linkAction.bind(null, id, num)} resetOnSuccess className="mt-2 grid grid-cols-[1fr_auto] gap-2">
                <select name="linkType" className="input col-span-2" defaultValue="related">
                  {LINK_TYPES.map((lt) => (
                    <option key={lt} value={lt}>{LINK_TYPE_LABELS[lt]}</option>
                  ))}
                </select>
                <input name="other" className="input" placeholder="e.g. PRB0001001" required />
                <SubmitButton className="btn">Link</SubmitButton>
              </ActionForm>
            )}
          </Card>

          {(can(actor, "cmdb.view") || d.cis.length > 0) && (
            <Card title="Configuration items">
              <ul className="space-y-1.5 text-sm">
                {d.cis.map((c) => (
                  <li key={c.ci_id} className="flex items-start justify-between gap-2">
                    <span>
                      {can(actor, "cmdb.view") ? <Link href={`/cmdb/${c.ci_id}`} className="font-mono text-xs">{c.ci_code}</Link> : <span className="font-mono text-xs">{c.ci_code}</span>} {c.name}
                      <span className="text-xs text-slate-500"> · {c.class_name} · {c.role}</span>
                    </span>
                    {access.canLink && (
                      <ActionForm action={unlinkCiAction.bind(null, id, num, c.ci_id)}>
                        <button className="text-xs text-slate-400 hover:text-red-600" aria-label="Remove">✕</button>
                      </ActionForm>
                    )}
                  </li>
                ))}
                {d.cis.length === 0 && <li className="text-slate-500">None</li>}
              </ul>
              {access.canLink && can(actor, "cmdb.view") && (
                <ActionForm action={linkCiAction.bind(null, id, num)} resetOnSuccess className="mt-2 grid grid-cols-[1fr_auto] gap-2">
                  <select name="role" className="input col-span-2" defaultValue={t.ticket_type === "change" ? "changed" : "affected"}>
                    <option value="affected">Affected</option>
                    <option value="caused_by">Caused by</option>
                    <option value="changed">Changed</option>
                    <option value="related">Related</option>
                  </select>
                  <input name="ciCode" className="input" placeholder="CI code" required />
                  <SubmitButton className="btn">Link</SubmitButton>
                </ActionForm>
              )}
            </Card>
          )}

          <Card title={`Attachments (${d.files.length})`}>
            <ul className="space-y-1 text-sm">
              {d.files.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-2">
                  {f.storage_key ? (
                    <a href={`/api/files/${f.id}`} className="truncate">{f.file_name}</a>
                  ) : (
                    <span className="truncate text-slate-500" title="The file content was not migrated from the old system">{f.file_name} (not migrated)</span>
                  )}
                  <span className="shrink-0 text-xs text-slate-400">{bytes(f.size_bytes)}</span>
                </li>
              ))}
              {d.files.length === 0 && <li className="text-slate-500">None</li>}
            </ul>
            {(access.canCommentPublic || access.canWork) && (
              <ActionForm action={uploadAction.bind(null, id, num)} resetOnSuccess className="mt-2 flex items-center gap-2">
                <input type="file" name="files" multiple className="min-w-0 flex-1 text-xs" />
                <SubmitButton className="btn btn-sm">Upload</SubmitButton>
              </ActionForm>
            )}
          </Card>

          {d.kb.length > 0 && (
            <Card title="Knowledge articles">
              <ul className="space-y-1 text-sm">
                {d.kb.map((a) => (
                  <li key={a.id}>
                    <Link href={`/kb/${a.id}`}>{a.number}</Link> {a.title}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <p className="px-1 text-xs text-slate-400">
            {TICKET_TYPE_LABELS[t.ticket_type]} · version {t.version}
            {t.legacy ? " · imported from the previous helpdesk" : ""}
          </p>
        </aside>
      </div>
    </>
  )
}
