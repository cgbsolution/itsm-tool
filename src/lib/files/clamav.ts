/**
 * Optional virus scanning through a ClamAV daemon (clamd INSTREAM over TCP).
 * Enabled when CLAMAV_ADDRESS=host:port is set.
 */
import net from "node:net"
import { config } from "@/lib/config"

export type ScanResult = "clean" | "infected" | "error" | "not_scanned"

export async function scanBuffer(buf: Buffer): Promise<{ result: ScanResult; signature?: string }> {
  const addr = config.clamavAddress()
  if (!addr) return { result: "not_scanned" }
  const [host, portStr] = addr.split(":")
  const port = Number(portStr || 3310)
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    let reply = ""
    const done = (r: { result: ScanResult; signature?: string }) => {
      socket.destroy()
      resolve(r)
    }
    socket.setTimeout(30_000, () => done({ result: "error" }))
    socket.on("error", () => done({ result: "error" }))
    socket.on("data", (d) => (reply += d.toString()))
    socket.on("end", () => {
      if (/OK\0?\s*$/.test(reply)) done({ result: "clean" })
      else if (/FOUND/.test(reply)) done({ result: "infected", signature: reply.replace(/^stream:\s*/, "").replace(/\s*FOUND.*$/s, "") })
      else done({ result: "error" })
    })
    socket.on("connect", () => {
      socket.write("zINSTREAM\0")
      const chunk = 64 * 1024
      for (let i = 0; i < buf.length; i += chunk) {
        const part = buf.subarray(i, i + chunk)
        const len = Buffer.alloc(4)
        len.writeUInt32BE(part.length)
        socket.write(len)
        socket.write(part)
      }
      socket.write(Buffer.alloc(4))
    })
  })
}
