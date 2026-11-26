import type { ReactNode } from "react"
import Link from "next/link"
import { notFound } from "next/navigation"
import { requirePermission, can } from "@/lib/auth/session"
import { AppError } from "@/lib/errors"
import { ciFormOptions, getCiDetail, type RelationshipRow, type WalkRow } from "@/lib/cmdb/queries"
import { formatAttribute } from "@/lib/cmdb/attributes"
import { todayIn } from "@/lib/cmdb/values"
import { HISTORY_LABELS, REL_LABELS, REL_TYPES, IMPACT_MAX_DEPTH, isRelType } from "@/lib/cmdb/vocab"
import { formatDate, formatDateTime } from "@/lib/format"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, KeyValues, PageHeader, StatusBadge, TypeBadge, When } from "@/components/ui"
import {
  addRelationshipAction, assignCiAction, deleteCiAction, removeRelationshipAction, retireCiAction, returnCiAction,
} from "../actions"
import { ChangeList, CiStatusBadge, WarrantyBadge, labelFor } from "../ui"

export const metadata = { title: "Configuration item" }

const cap = (s: string | null | undefined) => (s ? s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : null)

function RelList({ rows, direction, ciId, editable }: { rows: RelationshipRow[]; direction: "out" | "in"; ciId: string; editable: boolean }) {
  if (!rows.length) return <p className="text-sm text-slate-500">None</p>
  return (
    <ul className="space-y-1.5 text-sm">
      {rows.map((r) => (
        <li key={r.id} className="flex items-start justify-between gap-2">
          <span className="min-w-0">
            <span className="text-xs text-slate-500">{isRelType(r.rel_type) ? REL_LABELS[r.rel_type][direction] : r.rel_type}</span>{" "}
            <Link href={`/cmdb/${r.other_id}`} className="font-mono text-xs">{r.other_code}</Link> {r.other_name}
            <span className="text-xs text-slate-400"> · {r.other_class}</span>
            {(r.other_status === "retired" || r.other_status === "disposed") && <> <CiStatusBadge status={r.other_status} /></>}
          </span>
          {editable && (
            <ActionForm action={removeRelationshipAction.bind(null, ciId, r.id)} confirm="Remove this relationship?">
              <button className="text-xs text-slate-400 hover:text-red-600" aria-label="Remove relationship">✕</button>
            </ActionForm>
          )}
        </li>
      ))}
    </ul>
  )
}

function WalkTable({ rows, empty }: { rows: WalkRow[]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-slate-500">{empty}</p>
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Depth</th>
            <th>Item</th>
            <th>Status</th>
            <th>Path</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <Badge tone={r.depth === 1 ? "blue" : "gray"}>{r.depth === 1 ? "direct" : `level ${r.depth}`}</Badge>
              </td>
              <td>
                <Link href={`/cmdb/${r.id}`} className="font-mono text-xs">{r.ci_code}</Link> {r.name}
                <div className="text-xs text-slate-400">{r.class_name}</div>
              </td>
              <td><CiStatusBadge status={r.status} /></td>
              <td className="text-xs break-words text-slate-500">{r.path}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default async function CiPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("cmdb.view")
  const { id } = await params
  let d
  try {
    d = await getCiDetail(actor, id)
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  const { ci, schema } = d
  const tz = actor.tenant.timezone
  const today = todayIn(tz)
  const editor = can(actor, "cmdb.edit")
  const retired = ci.status === "retired" || ci.status === "disposed"
  const users = editor ? (await ciFormOptions(actor.tenantId)).users : []
  const extraAttrs = Object.entries(ci.attributes ?? {}).filter(([k]) => !schema.some((a) => a.key === k))

  return (
    <>
      <PageHeader
        back={{ href: "/cmdb", label: "CMDB" }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-base text-slate-500">{ci.ci_code}</span>
            <span>{ci.name}</span>
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="slate">{ci.class_name}</Badge>
            <CiStatusBadge status={ci.status} />
            {ci.criticality && <Badge tone={ci.criticality === "critical" ? "red" : ci.criticality === "high" ? "amber" : "gray"}>{cap(ci.criticality)} criticality</Badge>}
            {ci.environment && <Badge tone="blue">{cap(ci.environment)}</Badge>}
            <span className="text-xs">
              Added <When value={ci.created_at} timeZone={tz} /> ({ci.source}) · updated <When value={ci.updated_at} timeZone={tz} />
            </span>
          </span>
        }
        actions={
          <>
            {editor && <Link className="btn" href={`/cmdb/${ci.id}/edit`}>Edit</Link>}
            {editor && !retired && (
              <ActionForm action={retireCiAction.bind(null, ci.id)} confirm={`Retire ${ci.ci_code}? Its current assignment is ended.`}>
                <SubmitButton className="btn">Retire</SubmitButton>
              </ActionForm>
            )}
            {can(actor, "cmdb.delete") && (
              <ActionForm
                action={deleteCiAction.bind(null, ci.id)}
                confirm={`Delete ${ci.ci_code} permanently? Its relationships and ticket links are removed too. This is recorded in the audit log.`}
              >
                <SubmitButton className="btn btn-danger">Delete</SubmitButton>
              </ActionForm>
            )}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-4">
          <Card title="Details">
            <div className="grid gap-x-8 gap-y-2 md:grid-cols-2">
              <KeyValues
                items={[
                  ["Owner", ci.owner_id ? (ci.owner_name ? `${ci.owner_name} (${ci.owner_email})` : ci.owner_email) : null],
                  ["Support group", ci.support_group_name],
                  ["Organisation", ci.organization_name],
                  ["Location", ci.location],
                  ["Room", ci.room],
                  ["Department", ci.department],
                  ["Condition", cap(ci.condition)],
                ]}
              />
              <KeyValues
                items={[
                  ["Manufacturer", ci.manufacturer],
                  ["Model", ci.model],
                  ["Serial number", ci.serial_no ? <span key="s" className="font-mono text-xs">{ci.serial_no}</span> : null],
                  ["Purchased", ci.purchase_date ? formatDate(ci.purchase_date) : null],
                  ["Warranty", ci.warranty_expiry ? <WarrantyBadge key="w" expiry={ci.warranty_expiry} today={today} /> : ci.warranty_years !== null ? `${ci.warranty_years} years` : null],
                  ["Cost", ci.cost !== null ? ci.cost.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null],
                  ["Last seen by agent", ci.last_seen_at ? formatDateTime(ci.last_seen_at, tz) : null],
                ]}
              />
            </div>
            {ci.notes && (
              <div className="mt-4 border-t border-slate-100 pt-3">
                <h3 className="mb-1 text-xs font-semibold text-slate-500 uppercase">Notes</h3>
                <div className="prose-plain text-sm">{ci.notes}</div>
              </div>
            )}
          </Card>

          <Card title="Attributes">
            {schema.length === 0 && extraAttrs.length === 0 ? (
              <p className="text-sm text-slate-500">No attributes.</p>
            ) : (
              <KeyValues
                items={[
                  ...schema.map((a) => [a.label, formatAttribute(ci.attributes?.[a.key])] as [string, string]),
                  ...extraAttrs.map(([k, v]) => [<span key={k} title="Not part of the class">{labelFor(`attributes.${k}`)}</span>, formatAttribute(v)] as [ReactNode, string]),
                ]}
              />
            )}
          </Card>

          <Card title="Relationships">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h3 className="mb-2 text-xs font-semibold text-slate-500 uppercase">From this item</h3>
                <RelList rows={d.outgoing} direction="out" ciId={ci.id} editable={editor} />
              </div>
              <div>
                <h3 className="mb-2 text-xs font-semibold text-slate-500 uppercase">To this item</h3>
                <RelList rows={d.incoming} direction="in" ciId={ci.id} editable={editor} />
              </div>
            </div>
            {editor && (
              <ActionForm action={addRelationshipAction.bind(null, ci.id)} resetOnSuccess className="mt-4 grid gap-2 border-t border-slate-100 pt-3 sm:grid-cols-[auto_1fr_12rem_auto] sm:items-center">
                <span className="text-sm text-slate-600">
                  <span className="font-mono text-xs">{ci.ci_code}</span>
                </span>
                <select name="relType" className="input" defaultValue="depends_on" aria-label="Relationship type">
                  {REL_TYPES.map((t) => (
                    <option key={t} value={t}>{REL_LABELS[t].out.toLowerCase()}</option>
                  ))}
                </select>
                <input name="targetCode" className="input" placeholder="Other CI code" required maxLength={64} aria-label="Other CI code" />
                <SubmitButton className="btn">Add</SubmitButton>
              </ActionForm>
            )}
          </Card>

          <Card title={`Impact analysis (${d.impact.length})`}>
            <p className="hint mb-3 mt-0">
              Items that depend on {ci.ci_code}, directly or through others (up to {IMPACT_MAX_DEPTH} levels). Follows depends on, runs on, hosted on,
              installed on, uses and member of; for contains, the contained item depends on its container.
            </p>
            <WalkTable rows={d.impact} empty="Nothing depends on this item." />
          </Card>

          <Card title={`Depends on (${d.dependsOn.length})`}>
            <WalkTable rows={d.dependsOn} empty="This item does not depend on anything recorded." />
          </Card>

          <Card title={`Linked tickets (${d.ticketCount})`}>
            {!d.canSeeTickets ? (
              <p className="text-sm text-slate-500">{d.ticketCount} ticket{d.ticketCount === 1 ? "" : "s"} reference this item.</p>
            ) : d.tickets.length === 0 ? (
              <p className="text-sm text-slate-500">No tickets reference this item.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Number</th>
                      <th>Subject</th>
                      <th>Status</th>
                      <th>Role</th>
                      <th>Raised</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.tickets.map((t) => (
                      <tr key={t.id}>
                        <td className="whitespace-nowrap">
                          <Link href={`/tickets/${t.number}`} className="font-mono text-xs font-medium">{t.number}</Link>
                          <div className="mt-0.5"><TypeBadge type={t.ticket_type} /></div>
                        </td>
                        <td className="max-w-sm">{t.subject}</td>
                        <td><StatusBadge status={t.status} /></td>
                        <td className="text-slate-600">{cap(t.role)}</td>
                        <td className="whitespace-nowrap text-xs text-slate-500"><When value={t.created_at} timeZone={tz} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="History">
            {d.history.length === 0 ? (
              <p className="text-sm text-slate-500">No history yet.</p>
            ) : (
              <ol className="space-y-2.5 text-sm">
                {d.history.map((h) => (
                  <li key={h.id} className="flex gap-3">
                    <span className="w-32 shrink-0 text-xs text-slate-400" title={formatDateTime(h.created_at, tz)}>
                      {formatDateTime(h.created_at, tz)}
                    </span>
                    <div className="min-w-0">
                      <span className="font-medium">{h.actor_name ?? "System"}</span> {HISTORY_LABELS[h.action] ?? h.action}
                      {h.action !== "created" && h.action !== "import_created" && h.action !== "agent_created" ? (
                        <ChangeList changes={h.changes} schema={schema} />
                      ) : (
                        <details className="text-xs text-slate-500">
                          <summary className="cursor-pointer">Initial values</summary>
                          <ChangeList changes={h.changes} schema={schema} />
                        </details>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <aside className="space-y-4">
          <Card title="Assignment">
            {d.openAssignment ? (
              <div className="text-sm">
                <div className="font-medium">{d.openAssignment.user_name || d.openAssignment.user_email}</div>
                <div className="text-xs text-slate-500">
                  Since {formatDateTime(d.openAssignment.assigned_at, tz)}
                  {d.openAssignment.assigned_by_name ? ` · by ${d.openAssignment.assigned_by_name}` : ""}
                </div>
                {d.openAssignment.note && <div className="prose-plain mt-1 text-xs text-slate-600">{d.openAssignment.note}</div>}
              </div>
            ) : (
              <p className="text-sm text-slate-500">{ci.owner_id ? `Owner: ${ci.owner_name || ci.owner_email} (no assignment record)` : "Not assigned to anyone."}</p>
            )}
            {editor && !retired && (
              <ActionForm action={assignCiAction.bind(null, ci.id)} resetOnSuccess className="mt-3 space-y-2 border-t border-slate-100 pt-3">
                <select name="userId" className="input" required defaultValue="" aria-label="Person">
                  <option value="" disabled>Assign to…</option>
                  {users
                    .filter((u) => u.id !== ci.owner_id)
                    .map((u) => (
                      <option key={u.id} value={u.id}>{u.full_name ? `${u.full_name} · ${u.email}` : u.email}</option>
                    ))}
                </select>
                <input name="note" className="input" maxLength={1000} placeholder="Note (optional), e.g. with charger" />
                <SubmitButton className="btn w-full">{d.openAssignment || ci.owner_id ? "Reassign" : "Assign to user"}</SubmitButton>
              </ActionForm>
            )}
            {editor && (d.openAssignment || ci.owner_id) && (
              <ActionForm action={returnCiAction.bind(null, ci.id)} confirm="Record that the item was returned?" className="mt-2 space-y-2">
                <input name="note" className="input" maxLength={1000} placeholder="Return note (optional)" />
                <SubmitButton className="btn w-full">Return</SubmitButton>
              </ActionForm>
            )}
          </Card>

          <Card title={`Assignment history (${d.assignments.length})`}>
            {d.assignments.length === 0 ? (
              <p className="text-sm text-slate-500">None</p>
            ) : (
              <ol className="space-y-2 text-sm">
                {d.assignments.map((a) => (
                  <li key={a.id}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate">{a.user_name || a.user_email}</span>
                      {!a.returned_at && <Badge tone="green">current</Badge>}
                    </div>
                    <div className="text-xs text-slate-500">
                      {formatDate(a.assigned_at, tz)} → {a.returned_at ? formatDate(a.returned_at, tz) : "now"}
                      {a.assigned_by_name ? ` · by ${a.assigned_by_name}` : ""}
                    </div>
                    {a.note && <div className="prose-plain text-xs text-slate-500">{a.note}</div>}
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card title="Managed device">
            {d.devices.length === 0 ? (
              <p className="text-sm text-slate-500">No endpoint agent reports for this item.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {d.devices.map((dev) => (
                  <li key={dev.id}>
                    {can(actor, "endpoint.view") ? <Link href={`/endpoints/${dev.id}`} className="font-medium">{dev.hostname}</Link> : <span className="font-medium">{dev.hostname}</span>}
                    {dev.status === "retired" && <> <Badge>retired</Badge></>}
                    <div className="text-xs text-slate-500">
                      {dev.os_name ?? "Unknown OS"} · last seen <When value={dev.last_seen_at} timeZone={tz} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <p className="px-1 text-xs text-slate-400">
            {ci.class_name}{ci.class_active ? "" : " (inactive class)"} · created {formatDateTime(ci.created_at, tz)}
          </p>
        </aside>
      </div>
    </>
  )
}
