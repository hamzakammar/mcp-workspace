/**
 * Credential access audit log.
 *
 * Every read, write, and delete of a credential is logged here.
 * Rows are written to `credential_access_log` in Supabase.
 * This table is never exposed to API clients — backend-only.
 *
 * Fire-and-forget: logging failures are caught and logged to stderr
 * but never propagate to the caller.
 */

export type CredentialType =
  | "d2l_password"
  | "piazza_password"
  | "outline_password"
  | "d2l_token"
  | "piazza_token"
  | "outline_token"
  | "s3_state"
  | "api_key"
  | "all";   // used for delete_my_data which wipes everything at once

export type CredentialAction = "read" | "write" | "delete" | "encrypt" | "decrypt";

/**
 * Log a credential access event.
 *
 * @param userId         The user whose credential was accessed.
 * @param credentialType Which credential type was accessed.
 * @param action         What happened to it.
 * @param trigger        Human-readable name of the function / event that triggered this.
 */
export async function logCredentialAccess(
  userId: string,
  credentialType: CredentialType,
  action: CredentialAction,
  trigger: string
): Promise<void> {
  try {
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.SUPABASE_KEY;

    if (!sbUrl || !sbKey) return; // no Supabase configured — skip silently

    await fetch(`${sbUrl}/rest/v1/credential_access_log`, {
      method: "POST",
      headers: {
        apikey: sbKey,
        Authorization: `Bearer ${sbKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        user_id: userId,
        credential_type: credentialType,
        action,
        trigger,
        occurred_at: new Date().toISOString(),
      }),
    });
  } catch (e: any) {
    // Audit failures must never block the caller
    console.error(`[AUDIT] Failed to log ${action} of ${credentialType} for user ${userId}: ${e?.message}`);
  }
}
