/** POST /api/agent/v1/jobs/{id}: job progress and result (docs/AGENT_PROTOCOL.md). 409 when cancelled. */
import type { NextRequest } from "next/server"
import { updateJobFromAgent } from "@/lib/endpoints/agent"
import { BODY_LIMITS } from "@/lib/endpoints/protocol"
import { body, json, withDevice } from "@/lib/endpoints/http"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withDevice(req, async (device) => {
    const { id } = await params
    return json(await updateJobFromAgent(device, id, await body(req, BODY_LIMITS.job)))
  })
}
