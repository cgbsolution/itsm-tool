import type { NextRequest } from "next/server"
import { q1 } from "@/lib/db"
import { apiActor, apiError, json } from "@/lib/api"

export async function GET(req: NextRequest) {
  try {
    const actor = await apiActor(req)
    const row = await q1<{ n: number }>("select count(*) as n from notifications where user_id = $1 and not is_read", [actor.id])
    return json({ unread: row?.n ?? 0 })
  } catch (e) {
    return apiError(e)
  }
}
