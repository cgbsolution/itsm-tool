/**
 * Route-handler glue for the agent API (/api/agent/v1/*): device bearer
 * authentication, JSON bodies with size caps, and JSON errors. No cookies and
 * no user sessions are involved.
 */
import { apiError, json } from "@/lib/api"
import { authenticateDevice, type AgentDevice } from "@/lib/endpoints/agent"
import { readJsonBody, requestIp } from "@/lib/endpoints/protocol"

export { json, apiError }

/** Runs `fn` for an authenticated device; any error becomes a JSON error response (401, 400, 404, 409, …). */
export async function withDevice(req: Request, fn: (device: AgentDevice, ip: string | null) => Promise<Response>): Promise<Response> {
  try {
    const ip = requestIp(req.headers)
    const device = await authenticateDevice(req.headers, ip)
    return await fn(device, ip)
  } catch (e) {
    return apiError(e)
  }
}

/** Reads the JSON body of an agent request (caps in BODY_LIMITS). */
export function body(req: Request, maxBytes: number): Promise<unknown> {
  return readJsonBody(req, maxBytes)
}
