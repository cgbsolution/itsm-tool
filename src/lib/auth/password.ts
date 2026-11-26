import bcrypt from "bcryptjs"

const COST = 12

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST)
}

/**
 * Checks a password against a bcrypt hash ($2a$/$2b$/$2y$). Hashes migrated
 * from the old helpdesk (Supabase GoTrue, bcrypt) verify here unchanged.
 */
export async function verifyPassword(plain: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash || !/^\$2[aby]\$\d{2}\$/.test(hash)) return false
  try {
    return await bcrypt.compare(plain, hash)
  } catch {
    return false
  }
}

/** Old hashes with a lower cost are upgraded on the next successful sign-in. */
export function needsRehash(hash: string): boolean {
  const m = /^\$2[aby]\$(\d{2})\$/.exec(hash)
  return !m || Number(m[1]) < COST
}

const COMMON = new Set([
  "password", "password1", "password123", "12345678", "123456789", "1234567890", "qwerty123",
  "welcome1", "welcome123", "admin123", "letmein1", "iloveyou1", "changeme", "p@ssw0rd",
])

/** Returns a problem with the password, or null when it is acceptable. */
export function passwordProblem(plain: string, minLength: number, email?: string): string | null {
  if (plain.length < minLength) return `Use at least ${minLength} characters`
  if (plain.length > 200) return "Use at most 200 characters"
  if (COMMON.has(plain.toLowerCase())) return "That password is too common"
  if (email && plain.toLowerCase().includes(email.split("@")[0].toLowerCase()) && email.split("@")[0].length >= 4) {
    return "Do not use your email name in the password"
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(plain)).length
  if (classes < 2 && plain.length < 16) return "Mix letters with numbers or symbols, or use 16+ characters"
  return null
}
