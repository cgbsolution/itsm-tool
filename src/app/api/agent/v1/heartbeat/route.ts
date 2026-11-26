/** POST /api/agent/v1/heartbeat (docs/AGENT_PROTOCOL.md). */
import type { NextRequest } from "next/server"
import { recordHeartbeat } from "@/lib/endpoints/agent"
import { BODY_LIMITS } from "@/lib/endpoints/protocol"
import { body, json, withDevice } from "@/lib/endpoints/http"

export async function POST(req: NextRequest) {
  return withDevice(req, async (device, ip) => json(await recordHeartbeat(device, await body(req, BODY_LIMITS.heartbeat), ip)))
}
