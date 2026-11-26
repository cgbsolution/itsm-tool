/** POST /api/agent/v1/enroll: enrolment-token exchange for a device id and secret (docs/AGENT_PROTOCOL.md). */
import type { NextRequest } from "next/server"
import { apiError, json } from "@/lib/api"
import { enrollDevice } from "@/lib/endpoints/agent"
import { BODY_LIMITS, readJsonBody, requestIp } from "@/lib/endpoints/protocol"

export async function POST(req: NextRequest) {
  try {
    const ip = requestIp(req.headers)
    const input = await readJsonBody(req, BODY_LIMITS.enroll)
    return json(await enrollDevice(input, ip))
  } catch (e) {
    return apiError(e)
  }
}
