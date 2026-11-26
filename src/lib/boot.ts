/** Runs once when the server starts (see src/instrumentation.ts). */
import { config } from "@/lib/config"
import { log } from "@/lib/log"

export async function boot() {
  try {
    if (config.migrateOnStart()) {
      const { migrate } = await import("@/lib/db/migrate")
      const r = await migrate()
      if (r.applied.length) log.info("boot.migrated", { applied: r.applied })
    }
    const { bootstrapIfEmpty } = await import("@/lib/tenants")
    await bootstrapIfEmpty()
    if (config.workerEnabled()) {
      const { registerAll } = await import("@/lib/jobs/handlers")
      const { startWorker } = await import("@/lib/jobs/worker")
      registerAll()
      startWorker()
    }
  } catch (err) {
    log.error("boot.failed", { err })
  }
}
