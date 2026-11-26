/** POST /api/agent/v1/inventory: hardware, OS, network and software (docs/AGENT_PROTOCOL.md). */
import type { NextRequest } from "next/server"
import { ingestInventory } from "@/lib/endpoints/agent"
import { BODY_LIMITS } from "@/lib/endpoints/protocol"
import { body, json, withDevice } from "@/lib/endpoints/http"

export async function POST(req: NextRequest) {
  return withDevice(req, async (device) => json(await ingestInventory(device, await body(req, BODY_LIMITS.inventory))))
}
