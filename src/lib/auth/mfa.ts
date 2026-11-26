import { q1, exec } from "@/lib/db"
import { decryptSecret, encryptSecret } from "@/lib/crypto"
import { generateTotpSecret } from "@/lib/auth/totp"

/** The pending (not yet confirmed) TOTP secret for the setup page; created on first view. */
export async function pendingMfaSecret(userId: string): Promise<string | null> {
  const u = await q1<{ mfa_secret_enc: string | null; mfa_enabled: boolean }>("select mfa_secret_enc, mfa_enabled from users where id = $1", [userId])
  if (!u || u.mfa_enabled) return null
  if (u.mfa_secret_enc) {
    try {
      return decryptSecret(u.mfa_secret_enc)
    } catch {
      // APP_SECRET changed: start over
    }
  }
  const secret = generateTotpSecret()
  await exec("update users set mfa_secret_enc = $2 where id = $1 and not mfa_enabled", [userId, encryptSecret(secret)])
  return secret
}
