/**
 * Registers every job handler and schedule. Imported once at boot.
 * Modules add their own registration function here.
 */
import { registerHandler, registerSchedule } from "@/lib/jobs/worker"
import { deliverOutbox } from "@/lib/email/send"
import { runAutoClose, runCleanup, runSlaCheck } from "@/lib/itsm/sla-jobs"
import { runMailPoll } from "@/lib/email/inbound"
import { registerEndpointJobs } from "@/lib/endpoints/jobs"

export function registerAll() {
  registerHandler("email.send", async (p) => deliverOutbox(String(p.outboxId)))
  registerHandler("mail.poll", () => runMailPoll())
  registerSchedule("mail.poll", 120)
  registerHandler("sla.check", () => runSlaCheck())
  registerHandler("tickets.autoclose", () => runAutoClose())
  registerHandler("system.cleanup", () => runCleanup())

  registerSchedule("sla.check", 60)
  registerSchedule("tickets.autoclose", 3600)
  registerSchedule("system.cleanup", 86_400)

  // endpoints: scheduled deployments, patch policies (auto-approve + schedules), stuck agent jobs
  registerEndpointJobs()
}
