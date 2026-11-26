/**
 * GET /api/agent/download/{windows|linux}: the agent script, for admins
 * (signed-in session or API token with endpoint.manage). Admins copy it to
 * the device and install it with an enrolment token.
 */
import fs from "node:fs"
import path from "node:path"
import type { NextRequest } from "next/server"
import { apiActor, apiError, json, requirePerm } from "@/lib/api"
import { sha256Hex } from "@/lib/crypto"
import { notFound } from "@/lib/errors"

const AGENTS: Record<string, { dir: string; file: string; label: string }> = {
  windows: { dir: "windows", file: "itsm-agent.ps1", label: "Windows" },
  linux: { dir: "linux", file: "itsm-agent.py", label: "Linux" },
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ os: string }> }) {
  try {
    const actor = await apiActor(req)
    requirePerm(actor, "endpoint.manage")
    const { os } = await params
    const agent = Object.prototype.hasOwnProperty.call(AGENTS, os) ? AGENTS[os] : null
    if (!agent) throw notFound("Unknown agent. Use windows or linux.")
    const full = path.join(process.cwd(), "agent", agent.dir, agent.file)
    const buf = await fs.promises.readFile(full).catch(() => null)
    if (!buf) return json({ error: `The ${agent.label} agent (agent/${agent.dir}/${agent.file}) is not part of this installation yet.` }, 404)
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(buf.length),
        "Content-Disposition": `attachment; filename="${agent.file}"`,
        "X-Content-SHA256": sha256Hex(buf),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    })
  } catch (e) {
    return apiError(e)
  }
}
