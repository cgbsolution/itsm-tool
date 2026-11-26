// Readiness: database reachable and schema up to date. For load balancers and upgrades.
import { q1 } from "@/lib/db"
import { pendingMigrations } from "@/lib/db/migrate"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    await q1("select 1")
    const pending = await pendingMigrations()
    const stuck = await q1<{ n: number }>("select count(*) as n from jobs where status = 'queued' and run_at < now() - interval '15 minutes'")
    const ok = pending.length === 0
    return Response.json(
      { status: ok ? "ready" : "migrations_pending", pending_migrations: pending, overdue_jobs: stuck?.n ?? 0 },
      { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } }
    )
  } catch {
    return Response.json({ status: "database_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } })
  }
}
