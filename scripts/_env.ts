// Loads .env for command-line scripts (Next.js loads it by itself for the app).
import fs from "node:fs"

if (fs.existsSync(".env")) {
  try {
    process.loadEnvFile(".env")
  } catch {
    // ignore malformed .env; real environment variables still apply
  }
}
