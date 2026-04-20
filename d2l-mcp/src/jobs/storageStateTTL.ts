/**
 * Storage State TTL Job — daily cleanup.
 *
 * Scans all users in user_credentials, checks whether their S3 browser-state
 * object is older than STORAGE_STATE_MAX_AGE_DAYS days, and marks duo_required
 * for any that have expired. This is a proactive safety net so users get a
 * push notification before they hit a wall mid-conversation.
 *
 * Uses HeadObject to check age — no decryption required.
 */

import {
  getStorageStateCapturedAt,
  STORAGE_STATE_MAX_AGE_DAYS,
} from "../utils/s3Storage.js";
import { sendPushToUser } from "../api/push.js";

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // run daily

/** Fetch all unique user_ids from user_credentials table. */
async function getAllCredentialUserIds(): Promise<string[]> {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_KEY;

  if (!sbUrl || !sbKey) return [];

  try {
    const resp = await fetch(
      `${sbUrl}/rest/v1/user_credentials?select=user_id&duo_required_at=is.null`,
      {
        headers: {
          apikey: sbKey,
          Authorization: `Bearer ${sbKey}`,
        },
      }
    );
    if (!resp.ok) {
      console.error(`[TTL] Failed to fetch credential users: HTTP ${resp.status}`);
      return [];
    }
    const rows = (await resp.json()) as Array<{ user_id: string }>;
    // Deduplicate
    return [...new Set(rows.map((r) => r.user_id))];
  } catch (e: any) {
    console.error(`[TTL] Error fetching credential users: ${e?.message}`);
    return [];
  }
}

/** Mark a user's duo_required_at and send a push notification. */
async function markDuoRequired(userId: string): Promise<void> {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_KEY;

  if (!sbUrl || !sbKey) return;

  try {
    await fetch(
      `${sbUrl}/rest/v1/user_credentials?user_id=eq.${encodeURIComponent(userId)}`,
      {
        method: "PATCH",
        headers: {
          apikey: sbKey,
          Authorization: `Bearer ${sbKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          duo_required_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      }
    );

    await sendPushToUser(
      userId,
      "Horizon: re-authentication needed",
      "Your D2L session will expire soon. Open the app to re-authenticate."
    ).catch((e: Error) =>
      console.error(`[TTL] Push notification failed for ${userId}: ${e.message}`)
    );

    console.error(`[TTL] Marked duo_required for user ${userId} (storage state expired)`);
  } catch (e: any) {
    console.error(`[TTL] Failed to mark duo_required for ${userId}: ${e?.message}`);
  }
}

/** One run of the TTL check. */
export async function runStorageStateTTLCheck(): Promise<void> {
  console.error("[TTL] Starting storage state TTL check");
  const userIds = await getAllCredentialUserIds();
  console.error(`[TTL] Checking ${userIds.length} user(s)`);

  let expiredCount = 0;

  for (const userId of userIds) {
    try {
      const capturedAt = await getStorageStateCapturedAt(userId);

      if (!capturedAt) {
        // No storage state in S3 — no action needed
        continue;
      }

      const ageDays = (Date.now() - capturedAt.getTime()) / (24 * 60 * 60 * 1000);

      if (ageDays >= STORAGE_STATE_MAX_AGE_DAYS) {
        console.error(
          `[TTL] User ${userId}: storage state is ${ageDays.toFixed(1)} days old (limit: ${STORAGE_STATE_MAX_AGE_DAYS})`
        );
        await markDuoRequired(userId);
        expiredCount++;
      }
    } catch (e: any) {
      console.error(`[TTL] Error checking user ${userId}: ${e?.message}`);
    }
  }

  console.error(
    `[TTL] TTL check complete. ${expiredCount}/${userIds.length} user(s) marked for reauth.`
  );
}

/** Start the daily TTL job. Runs immediately then every 24h. */
export function startStorageStateTTLJob(): void {
  // Run once shortly after startup (offset by 10min to not compete with session refresh)
  setTimeout(() => {
    void runStorageStateTTLCheck();
    setInterval(() => void runStorageStateTTLCheck(), CLEANUP_INTERVAL_MS);
  }, 10 * 60 * 1000);

  console.error("[TTL] Storage state TTL job scheduled (runs daily)");
}
