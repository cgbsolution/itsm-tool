import Link from "next/link"
import { requirePermission, can } from "@/lib/auth/session"
import { listClasses } from "@/lib/cmdb/queries"
import { Badge, EmptyState, PageHeader } from "@/components/ui"

export const metadata = { title: "CI classes" }

const cap = (s: string) => s.replace(/^\w/, (c) => c.toUpperCase())

export default async function ClassesPage() {
  const actor = await requirePermission("cmdb.view")
  const classes = await listClasses(actor)
  const admin = can(actor, "admin.itsm")
  return (
    <>
      <PageHeader
        title="CI classes"
        subtitle="Kinds of configuration items and the attributes each one records"
        back={{ href: "/cmdb", label: "CMDB" }}
        actions={admin && <Link className="btn btn-primary" href="/cmdb/classes/new">New class</Link>}
      />
      {classes.length === 0 ? (
        <EmptyState title="No classes yet" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Category</th>
                <th>Attributes</th>
                <th className="text-right">Items</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {classes.map((c) => (
                <tr key={c.id} id={`c-${c.id}`}>
                  <td className="font-medium">
                    {c.name} {!c.is_active && <Badge>inactive</Badge>}
                  </td>
                  <td className="font-mono text-xs text-slate-600">{c.key}</td>
                  <td className="text-slate-600">{cap(c.category)}</td>
                  <td className="max-w-md text-xs text-slate-500">
                    {c.attributes.length ? c.attributes.map((a) => a.label + (a.required ? " *" : "")).join(", ") : "—"}
                  </td>
                  <td className="text-right">
                    {c.ci_count > 0 ? <Link href={`/cmdb?class=${c.key}`}>{c.ci_count}</Link> : <span className="text-slate-400">0</span>}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    {admin && <Link className="btn btn-sm" href={`/cmdb/classes/${c.id}`}>Edit</Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
