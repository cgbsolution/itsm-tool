// Liveness: the process is up. Does not touch the database.
export function GET() {
  return Response.json({ status: "ok", time: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } })
}
