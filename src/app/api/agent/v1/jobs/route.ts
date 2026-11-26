/**
 * GET /api/agent/v1/jobs?wait=25: long poll for work (docs/AGENT_PROTOCOL.md).
 * Answers as soon as jobs are queued for the device, or after `wait` seconds
 * (max 30) with an empty list. Returned jobs are marked dispatched.
 */
import type { NextRequest } from "next/server"
import { pollJobs } from "@/lib/endpoints/agent"
import { parseWait } from "@/lib/endpoints/protocol"
import { json, withDevice } from "@/lib/endpoints/http"

export async function GET(req: NextRequest) {
  return withDevice(req, async (device) => {
    const jobs = await pollJobs(device, parseWait(req.nextUrl.searchParams.get("wait")), req.signal)
    return json({ jobs })
  })
}
