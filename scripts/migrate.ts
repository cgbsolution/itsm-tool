import "./_env"
import { migrate } from "@/lib/db/migrate"
import { pool } from "@/lib/db"

async function main() {
  const { applied, total } = await migrate()
  console.log(applied.length ? `Applied ${applied.length} migration(s): ${applied.join(", ")}` : `Up to date (${total} migrations).`)
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => pool().end())
