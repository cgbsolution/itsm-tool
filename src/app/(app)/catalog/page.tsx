import Link from "next/link"
import { requireActor, can } from "@/lib/auth/session"
import { browseCatalog } from "@/lib/catalog/queries"
import { Badge, EmptyState, PageHeader } from "@/components/ui"

export const metadata = { title: "Service catalog" }

export default async function CatalogPage() {
  const actor = await requireActor()
  const sections = await browseCatalog(actor)
  const manager = can(actor, "catalog.manage")
  return (
    <>
      <PageHeader
        title="Service catalog"
        subtitle="Request hardware, software and access. Each request becomes a ticket you can follow under My tickets."
        actions={
          manager && (
            <Link className="btn" href="/catalog/manage">
              Manage catalog
            </Link>
          )
        }
      />
      {sections.length === 0 ? (
        <EmptyState
          title="The catalog is empty"
          action={
            manager ? (
              <Link className="btn btn-primary" href="/catalog/manage">
                Set up the catalog
              </Link>
            ) : undefined
          }
        >
          {manager ? "Add items, or create a starter set (laptop, software, VPN, shared mailbox) on the manage page." : "Nothing can be requested here yet. You can still raise a request from Tickets."}
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {sections.map((s) => (
            <section key={s.id} aria-labelledby={`cat-${s.id}`}>
              <h2 id={`cat-${s.id}`}>{s.name}</h2>
              {s.description && <p className="mt-0.5 text-sm text-slate-500">{s.description}</p>}
              <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {s.items.map((i) => (
                  <Link key={i.id} href={`/catalog/${i.id}`} className="card card-body block text-inherit no-underline transition-colors hover:border-brand hover:no-underline">
                    <div className="font-medium text-slate-900">{i.name}</div>
                    {i.short_description && <p className="mt-1 line-clamp-3 text-sm text-slate-600">{i.short_description}</p>}
                    {(i.requires_approval || i.visibility === "staff") && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {i.requires_approval && <Badge tone="amber">Needs approval</Badge>}
                        {i.visibility === "staff" && <Badge tone="purple">IT staff only</Badge>}
                      </div>
                    )}
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
