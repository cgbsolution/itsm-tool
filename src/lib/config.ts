/**
 * Runtime configuration from environment variables. Read lazily so that
 * `next build` can import modules without a configured environment.
 */
import path from "node:path"

function env(name: string): string | undefined {
  const v = process.env[name]
  return v === undefined || v === "" ? undefined : v
}

function bool(name: string, fallback: boolean): boolean {
  const v = env(name)
  if (v === undefined) return fallback
  return ["1", "true", "yes", "on"].includes(v.toLowerCase())
}

export const config = {
  appUrl(): string {
    return (env("APP_URL") ?? "http://localhost:3000").replace(/\/+$/, "")
  },
  databaseUrl(): string {
    const url = env("DATABASE_URL")
    if (!url) throw new Error("DATABASE_URL is not set")
    return url
  },
  appSecret(): string {
    const s = env("APP_SECRET")
    if (!s || s.length < 32) {
      if (process.env.NODE_ENV === "production") {
        throw new Error("APP_SECRET must be set to at least 32 characters")
      }
      return "development-only-secret-do-not-use-in-production"
    }
    return s
  },
  productName(): string {
    return env("PRODUCT_NAME") ?? "ITSM Suite"
  },
  storageDir(): string {
    return path.resolve(env("STORAGE_DIR") ?? "./data/files")
  },
  migrationsDir(): string {
    return path.resolve(env("MIGRATIONS_DIR") ?? "./db/migrations")
  },
  migrateOnStart(): boolean {
    return bool("MIGRATE_ON_START", true)
  },
  workerEnabled(): boolean {
    return bool("WORKER_ENABLED", true)
  },
  cookieSecure(): boolean {
    const v = env("COOKIE_SECURE")
    if (v !== undefined) return bool("COOKIE_SECURE", false)
    return config.appUrl().startsWith("https://")
  },
  smtp() {
    return {
      host: env("SMTP_HOST"),
      port: Number(env("SMTP_PORT") ?? 587),
      secure: bool("SMTP_SECURE", false),
      user: env("SMTP_USER"),
      password: env("SMTP_PASSWORD"),
      from: env("SMTP_FROM"),
    }
  },
  clamavAddress(): string | undefined {
    return env("CLAMAV_ADDRESS")
  },
  licensePublicKeyFile(): string | undefined {
    return env("LICENSE_PUBLIC_KEY_FILE")
  },
  licensePublicKeyPem(): string | undefined {
    return env("LICENSE_PUBLIC_KEY")
  },
  logLevel(): string {
    return env("LOG_LEVEL") ?? "info"
  },
  maxUploadBytes(): number {
    return Number(env("MAX_UPLOAD_MB") ?? 25) * 1024 * 1024
  },
  bootstrap() {
    return {
      tenantName: env("BOOTSTRAP_TENANT_NAME") ?? "Default",
      adminEmail: env("BOOTSTRAP_ADMIN_EMAIL"),
      adminPassword: env("BOOTSTRAP_ADMIN_PASSWORD"),
    }
  },
}
