/**
 * Fixed-window rate limiting stored in Postgres, so it holds across app
 * replicas. Used for sign-in, password reset, enrolment and the public API.
 */
import { q1 } from "@/lib/db"
import { AppError } from "@/lib/errors"

export async function hit(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number }> {
  const row = await q1<{ hits: number }>(
    `insert into rate_limits as r (key, window_start, hits)
     values ($1, now(), 1)
     on conflict (key) do update set
       hits = case when r.window_start < now() - make_interval(secs => $2) then 1 else r.hits + 1 end,
       window_start = case when r.window_start < now() - make_interval(secs => $2) then now() else r.window_start end
     returning hits`,
    [key, windowSeconds]
  )
  const hits = row?.hits ?? 1
  return { allowed: hits <= limit, remaining: Math.max(0, limit - hits) }
}

export async function enforce(key: string, limit: number, windowSeconds: number, message = "Too many attempts. Wait a few minutes and try again.") {
  const r = await hit(key, limit, windowSeconds)
  if (!r.allowed) throw new AppError(message, 429, "rate_limited")
}
