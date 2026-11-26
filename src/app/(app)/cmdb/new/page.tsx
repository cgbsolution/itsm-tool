import Link from "next/link"
import { requirePermission } from "@/lib/auth/session"
import { ciFormOptions, getClass, listClasses } from "@/lib/cmdb/queries"
import { CLASS_CATEGORIES } from "@/lib/cmdb/vocab"
import { ActionForm, SubmitButton } from "@/components/client"
import { EmptyState, PageHeader } from "@/components/ui"
import { createCiAction } from "../actions"
import { CiFields } from "../ui"

export const metadata = { title: "New configuration item" }

const cap = (s: string) => s.replace(/^\w/, (c) => c.toUpperCase())

export default async function NewCiPage({ searchParams }: { searchParams: Promise<{ class?: string }> }) {
  const actor = await requirePermission("cmdb.edit")
  const sp = await searchParams
  const cls = sp.class ? await getClass(actor, sp.class) : null

  if (!cls || !cls.is_active) {
    const classes = await listClasses(actor, { activeOnly: true })
    return (
      <>
        <PageHeader title="New configuration item" subtitle="First choose what kind of item it is" back={{ href: "/cmdb", label: "CMDB" }} />
        {sp.class && <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">That class does not exist or is no longer in use.</p>}
        {classes.length === 0 ? (
          <EmptyState title="No classes" action={<Link className="btn" href="/cmdb/classes">Manage classes</Link>}>
            An administrator needs to set up CI classes first.
          </EmptyState>
        ) : (
          <div className="space-y-5">
            {CLASS_CATEGORIES.filter((cat) => classes.some((c) => c.category === cat)).map((cat) => (
              <section key={cat}>
                <h2 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">{cap(cat)}</h2>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {classes
                    .filter((c) => c.category === cat)
                    .map((c) => (
                      <Link key={c.id} href={`/cmdb/new?class=${c.key}`} className="card card-body block text-inherit no-underline hover:border-slate-300 hover:no-underline">
                        <div className="font-medium text-slate-800">{c.name}</div>
                        <div className="text-xs text-slate-500">
                          {c.attributes.length} attribute{c.attributes.length === 1 ? "" : "s"} · {c.ci_count} item{c.ci_count === 1 ? "" : "s"}
                        </div>
                      </Link>
                    ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </>
    )
  }

  const options = await ciFormOptions(actor.tenantId)
  return (
    <>
      <PageHeader
        title={`New ${cls.name.toLowerCase()}`}
        subtitle={<Link href="/cmdb/new">Choose another class</Link>}
        back={{ href: "/cmdb", label: "CMDB" }}
      />
      <ActionForm action={createCiAction} className="max-w-5xl space-y-4">
        <input type="hidden" name="classId" value={cls.id} />
        <CiFields schema={cls.attributes} {...options} />
        <SubmitButton pendingText="Creating…">Create item</SubmitButton>
      </ActionForm>
    </>
  )
}
