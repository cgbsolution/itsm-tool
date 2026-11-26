/**
 * In-process worker for the Postgres job queue. Safe with several app
 * replicas: jobs are claimed with FOR UPDATE SKIP LOCKED and scheduled runs
 * use a dedupe key per time slot, so each runs once.
 */
import os from "node:os"
import { q, exec, pool } from "@/lib/db"
import { enqueue } from "@/lib/jobs/queue"
import { log } from "@/lib/log"

export type Job = { id: number; kind: string; payload: Record<string, unknown>; attempts: number; max_attempts: number }
export type Handler = (payload: Record<string, unknown>, job: Job) => Promise<void>

const g = globalThis as unknown as {
  __itsmHandlers?: Map<string, Handler>
  __itsmSchedules?: Map<string, { everySeconds: number; payload: Record<string, unknown> }>
  __itsmWorker?: NodeJS.Timeout
}
const handlers = (g.__itsmHandlers ??= new Map())
const schedules = (g.__itsmSchedules ??= new Map())

export function registerHandler(kind: string, fn: Handler) {
  handlers.set(kind, fn)
}

/** Runs `kind` every `everySeconds` (once per slot across all replicas). */
export function registerSchedule(kind: string, everySeconds: number, payload: Record<string, unknown> = {}) {
  schedules.set(kind, { everySeconds, payload })
}

function backoffSeconds(attempt: number) {
  return Math.min(3600, 15 * 2 ** Math.max(0, attempt - 1))
}

async function enqueueSchedules(now: number) {
  for (const [kind, s] of schedules) {
    const slot = Math.floor(now / 1000 / s.everySeconds)
    await enqueue(kind, s.payload, { dedupeKey: `sched:${kind}:${slot}`, maxAttempts: 1 })
  }
}

async function runJob(job: Job) {
  const fn = handlers.get(job.kind)
  try {
    if (!fn) throw new Error(`No handler for job kind ${job.kind}`)
    await fn(job.payload, job)
    await exec("update jobs set status = 'done', finished_at = now(), last_error = null where id = $1", [job.id])
  } catch (err) {
    const dead = job.attempts >= job.max_attempts
    await exec(
      `update jobs set status = $2, last_error = $3, locked_by = null,
              run_at = case when $2 = 'queued' then now() + make_interval(secs => $4) else run_at end,
              finished_at = case when $2 = 'dead' then now() else null end
        where id = $1`,
      [job.id, dead ? "dead" : "queued", ((err as Error).message ?? String(err)).slice(0, 1000), backoffSeconds(job.attempts)]
    )
    log[dead ? "error" : "warn"]("job.failed", { job_id: job.id, kind: job.kind, attempt: job.attempts, dead, err })
  }
}

let ticking = false
async function tick(workerId: string) {
  if (ticking) return
  ticking = true
  try {
    await enqueueSchedules(Date.now())
    await exec("update jobs set status = 'queued', locked_by = null where status = 'running' and locked_at < now() - interval '15 minutes'")
    for (let round = 0; round < 10; round++) {
      const jobs = await q<Job>(
        `update jobs set status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1
          where id in (select id from jobs where status = 'queued' and run_at <= now() order by run_at, id limit 5 for update skip locked)
          returning id, kind, payload, attempts, max_attempts`,
        [workerId]
      )
      if (jobs.length === 0) break
      await Promise.all(jobs.map(runJob))
    }
  } catch (err) {
    log.error("worker.tick_failed", { err })
  } finally {
    ticking = false
  }
}

export function startWorker() {
  if (g.__itsmWorker) return
  const workerId = `${os.hostname()}:${process.pid}`
  g.__itsmWorker = setInterval(() => void tick(workerId), 2000)
  g.__itsmWorker.unref?.()
  log.info("worker.started", { worker: workerId, handlers: [...handlers.keys()], schedules: [...schedules.keys()] })
}

export function stopWorker() {
  if (g.__itsmWorker) clearInterval(g.__itsmWorker)
  g.__itsmWorker = undefined
}

/** Queue status for the admin screen. */
export async function queueStats() {
  return q<{ kind: string; status: string; n: number }>(
    "select kind, status, count(*) as n from jobs where created_at > now() - interval '7 days' or status in ('queued', 'running', 'dead') group by kind, status order by kind, status",
    [],
    pool()
  )
}
