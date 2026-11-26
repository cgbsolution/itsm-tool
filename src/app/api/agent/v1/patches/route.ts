/** POST /api/agent/v1/patches: patch scan results (docs/AGENT_PROTOCOL.md). Returns { ok, missing }. */
import type { NextRequest } from "next/server"
import { ingestPatchScan } from "@/lib/endpoints/agent"
import { BODY_LIMITS } from "@/lib/endpoints/protocol"
import { body, json, withDevice } from "@/lib/endpoints/http"

export async function POST(req: NextRequest) {
  return withDevice(req, async (device) => json(await ingestPatchScan(device, await body(req, BODY_LIMITS.patches))))
}
