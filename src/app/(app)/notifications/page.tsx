import Link from "next/link"
import { revalidatePath } from "next/cache"
import { requireActor } from "@/lib/auth/session"
import { q, exec } from "@/lib/db"
import { ActionForm, SubmitButton } from "@/components/client"
import { EmptyState, PageHeader, When } from "@/components/ui"
import { ok, type FormState } from "@/lib/actions"

export const metadata = { title: "Notifications" }

async function markAllRead(): Promise<FormState> {
  "use server"
  const actor = await requireActor()
  await exec("update notifications set is_read = true where user_id = $1 and not is_read", [actor.id])
  revalidatePath("/notifications")
  return ok("All marked as read")
}

export default async function NotificationsPage() {
  const actor = await requireActor()
  const rows = await q<{ id: string; title: string; body: string | null; link: string | null; is_read: boolean; created_at: Date; actor_name: string | null }>(
    `select n.id, n.title, n.body, n.link, n.is_read, n.created_at, u.full_name as actor_name
       from notifications n left join users u on u.id = n.actor_id
      where n.user_id = $1 order by n.created_at desc limit 100`,
    [actor.id]
  )
  // opening the page marks what is shown as read (after rendering it as unread once)
  await exec("update notifications set is_read = true where user_id = $1 and not is_read and id = any($2::uuid[])", [actor.id, rows.map((r) => r.id)])
  return (
    <>
      <PageHeader
        title="Notifications"
        actions={
          <ActionForm action={markAllRead}>
            <SubmitButton className="btn">Mark all read</SubmitButton>
          </ActionForm>
        }
      />
      {rows.length === 0 ? (
        <EmptyState title="No notifications yet" />
      ) : (
        <ul className="card divide-y divide-slate-100">
          {rows.map((n) => (
            <li key={n.id} className={`flex gap-3 px-4 py-3 text-sm ${n.is_read ? "" : "bg-blue-50/50"}`}>
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.is_read ? "bg-transparent" : "bg-brand"}`} />
              <div className="min-w-0 flex-1">
                <div>
                  {n.actor_name && <span className="font-medium">{n.actor_name}: </span>}
                  {n.link ? <Link href={n.link}>{n.title}</Link> : n.title}
                </div>
                {n.body && <div className="truncate text-slate-500">{n.body}</div>}
              </div>
              <span className="shrink-0 text-xs text-slate-400">
                <When value={n.created_at} timeZone={actor.tenant.timezone} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
