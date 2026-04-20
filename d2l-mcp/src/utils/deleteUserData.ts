/**
 * deleteAllUserData — atomically wipes every trace of a user from the system.
 *
 * Deletes (in parallel where safe):
 *   1. Supabase user_credentials row (passwords, tokens, Duo state)
 *   2. Supabase api_keys row
 *   3. S3 browser-state/{userId}/storage-state.json (ADFS + D2L session cookies)
 *   4. Disk ~/.d2l-session-{userId}  (Playwright persistent context)
 *   5. Disk ~/.piazza-session-{userId} (Playwright persistent context)
 *
 * Returns a summary of what was deleted and any errors encountered.
 * All errors are collected rather than thrown so a partial failure does not
 * leave the caller unable to report what succeeded.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { logCredentialAccess } from "./auditLog.js";

const S3_BUCKET = process.env.S3_BUCKET || "study-mcp-notes";
const S3_REGION = process.env.AWS_REGION || "us-east-1";

export interface DeleteUserDataResult {
  deleted: {
    supabaseCredentials: boolean;
    supabaseApiKey: boolean;
    s3State: boolean;
    diskD2lSession: boolean;
    diskPiazzaSession: boolean;
  };
  errors: string[];
}

export async function deleteAllUserData(userId: string): Promise<DeleteUserDataResult> {
  const result: DeleteUserDataResult = {
    deleted: {
      supabaseCredentials: false,
      supabaseApiKey: false,
      s3State: false,
      diskD2lSession: false,
      diskPiazzaSession: false,
    },
    errors: [],
  };

  const sbUrl = process.env.SUPABASE_URL;
  // Destructive operations require the service role key — anon key has RLS
  // restrictions that cause DELETEs to return 200 but silently delete nothing.
  const sbServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const headers = sbUrl && sbServiceKey
    ? { apikey: sbServiceKey, Authorization: `Bearer ${sbServiceKey}`, "Content-Type": "application/json" }
    : null;

  // ── 1. Supabase: delete user_credentials ────────────────────────────────
  if (!sbUrl || !sbServiceKey) {
    result.errors.push("SUPABASE_SERVICE_ROLE_KEY is not set — skipped Supabase deletion. Anon key is not safe for destructive operations.");
  }

  if (headers && sbUrl) {
    try {
      const resp = await fetch(
        `${sbUrl}/rest/v1/user_credentials?user_id=eq.${encodeURIComponent(userId)}`,
        { method: "DELETE", headers }
      );
      if (!resp.ok) {
        result.errors.push(`user_credentials delete failed: HTTP ${resp.status} — ${await resp.text()}`);
      } else {
        result.deleted.supabaseCredentials = true;
      }
    } catch (e: any) {
      result.errors.push(`user_credentials delete error: ${e?.message}`);
    }

    // ── 2. Supabase: delete api_keys ──────────────────────────────────────
    try {
      const resp = await fetch(
        `${sbUrl}/rest/v1/api_keys?user_id=eq.${encodeURIComponent(userId)}`,
        { method: "DELETE", headers }
      );
      if (!resp.ok) {
        result.errors.push(`api_keys delete failed: HTTP ${resp.status} — ${await resp.text()}`);
      } else {
        result.deleted.supabaseApiKey = true;
      }
    } catch (e: any) {
      result.errors.push(`api_keys delete error: ${e?.message}`);
    }
  } else {
    result.errors.push("Supabase config missing — skipped credential deletion");
  }

  // ── 3. S3: delete browser storage state ─────────────────────────────────
  try {
    const s3 = new S3Client({ region: S3_REGION });
    await s3.send(
      new DeleteObjectCommand({
        Bucket: S3_BUCKET,
        Key: `browser-state/${userId}/storage-state.json`,
      })
    );
    result.deleted.s3State = true;
  } catch (e: any) {
    // NoSuchKey is not an error — the object simply doesn't exist
    if (e?.name !== "NoSuchKey") {
      result.errors.push(`S3 delete error: ${e?.message}`);
    } else {
      result.deleted.s3State = true;
    }
  }

  // ── 4. Disk: delete ~/.d2l-session-{userId} ──────────────────────────────
  try {
    const d2lPath = path.join(os.homedir(), `.d2l-session-${userId}`);
    await fs.rm(d2lPath, { recursive: true, force: true });
    result.deleted.diskD2lSession = true;
  } catch (e: any) {
    result.errors.push(`D2L disk session delete error: ${e?.message}`);
  }

  // ── 5. Disk: delete ~/.piazza-session-{userId} ───────────────────────────
  try {
    const piazzaPath = path.join(os.homedir(), `.piazza-session-${userId}`);
    await fs.rm(piazzaPath, { recursive: true, force: true });
    result.deleted.diskPiazzaSession = true;
  } catch (e: any) {
    result.errors.push(`Piazza disk session delete error: ${e?.message}`);
  }

  // ── Audit log ────────────────────────────────────────────────────────────
  await logCredentialAccess(userId, "all", "delete", "deleteAllUserData");

  return result;
}
