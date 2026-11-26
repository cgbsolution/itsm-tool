// Verifies the audit log hash chain:  npm run audit:verify
import "./_env"
import { verifyAuditChain } from "@/lib/audit"
import { pool } from "@/lib/db"

verifyAuditChain()
  .then((r) => {
    if (r.brokenAt === null) console.log(`Audit log intact (${r.checked} entries).`)
    else {
      console.error(`Audit log chain broken at entry ${r.brokenAt} (of ${r.checked}).`)
      process.exitCode = 2
    }
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => pool().end())
