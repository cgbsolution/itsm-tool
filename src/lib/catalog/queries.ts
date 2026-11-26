/** Read side of the service catalog: browsing, the item page, and the admin views. */
import { q, q1, isUuid } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { notFound } from "@/lib/errors"
import { loadItsmConfig } from "@/lib/itsm/config"
import { canSeeItem, type CatalogCategoryRow, type CatalogItemRow } from "@/lib/catalog/service"

export type CatalogCard = Pick<CatalogItemRow, "id" | "name" | "short_description" | "requires_approval" | "visibility" | "category_id">

/** Active items the actor may request, grouped by active category (items without a category last). */
export async function browseCatalog(actor: Actor) {
  const staff = actor.permissions.has("ticket.view_all")
  const [categories, items] = await Promise.all([
    q<Pick<CatalogCategoryRow, "id" | "name" | "description">>(
      "select id, name, description from catalog_categories where tenant_id = $1 and is_active order by sort_order, lower(name)",
      [actor.tenantId]
    ),
    q<CatalogCard>(
      `select i.id, i.name, i.short_description, i.requires_approval, i.visibility, i.category_id
         from catalog_items i left join catalog_categories c on c.id = i.category_id
        where i.tenant_id = $1 and i.is_active ${staff ? "" : "and i.visibility = 'all'"}
          and (i.category_id is null or c.is_active)
        order by i.sort_order, lower(i.name)`,
      [actor.tenantId]
    ),
  ])
  const sections = categories.map((c) => ({ ...c, items: items.filter((i) => i.category_id === c.id) })).filter((s) => s.items.length > 0)
  const other = items.filter((i) => !i.category_id)
  if (other.length) sections.push({ id: "other", name: categories.length ? "Other requests" : "Requests", description: null, items: other })
  return sections
}

export type CatalogItemDetail = CatalogItemRow & {
  category_name: string | null
  fulfilment_group_name: string | null
  approver_group_name: string | null
}

/**
 * An item for its request page. Requesters see only active items they may see;
 * catalog managers may also open inactive and staff-only items (to preview them).
 */
export async function getCatalogItem(actor: Actor, id: string): Promise<CatalogItemDetail & { preview: boolean }> {
  if (!isUuid(id)) throw notFound("Catalog item not found")
  const item = await q1<CatalogItemDetail>(
    `select i.*, c.name as category_name, fg.name as fulfilment_group_name, ag.name as approver_group_name
       from catalog_items i
       left join catalog_categories c on c.id = i.category_id
       left join groups fg on fg.id = i.fulfilment_group_id
       left join groups ag on ag.id = i.approver_group_id
      where i.id = $1 and i.tenant_id = $2`,
    [id, actor.tenantId]
  )
  if (!item) throw notFound("Catalog item not found")
  if (canSeeItem(actor, item)) return { ...item, preview: false }
  if (actor.permissions.has("catalog.manage")) return { ...item, preview: true }
  throw notFound("Catalog item not found")
}

/** Everything for the admin pages (catalog.manage is checked by the page). */
export async function adminCatalog(actor: Actor) {
  const [categories, items] = await Promise.all([
    q<CatalogCategoryRow & { items: number }>(
      `select c.*, (select count(*) from catalog_items i where i.category_id = c.id and i.tenant_id = c.tenant_id) as items
         from catalog_categories c where c.tenant_id = $1 order by c.sort_order, lower(c.name)`,
      [actor.tenantId]
    ),
    q<
      CatalogItemRow & { category_name: string | null; category_sort: number | null; fulfilment_group_name: string | null; approver_group_name: string | null; field_count: number; task_count: number }
    >(
      `select i.*, c.name as category_name, c.sort_order as category_sort, fg.name as fulfilment_group_name, ag.name as approver_group_name,
              jsonb_array_length(case when jsonb_typeof(i.form_fields) = 'array' then i.form_fields else '[]'::jsonb end) as field_count,
              jsonb_array_length(case when jsonb_typeof(i.task_templates) = 'array' then i.task_templates else '[]'::jsonb end) as task_count
         from catalog_items i
         left join catalog_categories c on c.id = i.category_id
         left join groups fg on fg.id = i.fulfilment_group_id
         left join groups ag on ag.id = i.approver_group_id
        where i.tenant_id = $1
        order by c.sort_order nulls last, lower(c.name), i.sort_order, lower(i.name)`,
      [actor.tenantId]
    ),
  ])
  return { categories, items }
}

export async function adminItem(actor: Actor, id: string): Promise<CatalogItemRow> {
  if (!isUuid(id)) throw notFound("Item not found")
  const item = await q1<CatalogItemRow>("select * from catalog_items where id = $1 and tenant_id = $2", [id, actor.tenantId])
  if (!item) throw notFound("Item not found")
  return item
}

/** Choices for the item form: catalog categories, groups, and ticket categories offered for requests. */
export async function itemFormOptions(actor: Actor) {
  const [categories, groups, cfg] = await Promise.all([
    q<{ id: string; name: string }>("select id, name from catalog_categories where tenant_id = $1 order by sort_order, lower(name)", [actor.tenantId]),
    q<{ id: string; name: string; kind: string }>("select id, name, kind from groups where tenant_id = $1 and is_active order by lower(name)", [actor.tenantId]),
    loadItsmConfig(actor.tenantId),
  ])
  const offered = (c: { ticket_types: string[] | null; is_active: boolean }) => c.is_active && (!c.ticket_types || c.ticket_types.includes("service_request"))
  const ticketCategories: { id: string; label: string }[] = []
  for (const p of cfg.categories.filter((c) => !c.parent_id && offered(c))) {
    ticketCategories.push({ id: p.id, label: p.name })
    for (const s of cfg.categories.filter((c) => c.parent_id === p.id && c.is_active)) ticketCategories.push({ id: s.id, label: `${p.name} › ${s.name}` })
  }
  return { categories, groups, ticketCategories }
}
