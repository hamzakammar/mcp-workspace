/**
 * deleteAllUserData — atomically wipes every trace of a user from the system.
 *
 * Deletes (in parallel where safe):
 *   1. Supabase user_credentials row (passwords, tokens, Duo state)
 *   2. Supabase api_keys row
 *   3. Supabase OAuth tokens/codes (oauth_access_tokens, oauth_refresh_tokens,
 *      oauth_authorization_codes) for the user
 *   4. S3 everything under browser-state/{userId}/ (D2L, Outline, Crowdmark …
 *      session cookies)
 *   5. Disk ~/.d2l-session-{userId}  (Playwright persistent context)
 *   6. Disk ~/.piazza-session-{userId} (Playwright persistent context)
 *   7. Disk os.tmpdir() temp state files for the user (isStorageStateTempFileFor)
 *
 * Returns a summary of what was deleted and any errors encountered.
 * All errors are collected rather than thrown so a partial failure does not
 * leave the caller unable to report what succeeded.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  S3Client,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { logCredentialAccess } from "./auditLog.js";
import { isStorageStateTempFileFor } from "./s3Storage.js";

const S3_BUCKET = process.env.S3_BUCKET || "study-mcp-notes";
const S3_REGION = process.env.AWS_REGION || "us-east-1";

export interface DeleteUserDataResult {
  deleted: {
    supabaseCredentials: boolean;
    supabaseApiKey: boolean;
    oauthTokens: boolean;
    s3State: boolean;
    diskD2lSession: boolean;
    diskPiazzaSession: boolean;
    tmpFiles: boolean;
  };
  errors: string[];
}

export async function deleteAllUserData(userId: string): Promise<DeleteUserDataResult> {
  const result: DeleteUserDataResult = {
    deleted: {
      supabaseCredentials: false,
      supabaseApiKey: false,
      oauthTokens: false,
      s3State: false,
      diskD2lSession: false,
      diskPiazzaSession: false,
      tmpFiles: false,
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

    // ── 3. Supabase: delete OAuth tokens + pending auth codes ─────────────
    // Deleting (rather than flagging revoked) also means the gateway can no
    // longer resolve any outstanding bearer token to this user.
    let oauthOk = true;
    for (const table of ["oauth_access_tokens", "oauth_refresh_tokens", "oauth_authorization_codes"]) {
      try {
        const resp = await fetch(
          `${sbUrl}/rest/v1/${table}?user_id=eq.${encodeURIComponent(userId)}`,
          { method: "DELETE", headers }
        );
        if (!resp.ok) {
          oauthOk = false;
          result.errors.push(`${table} delete failed: HTTP ${resp.status} — ${await resp.text()}`);
        }
      } catch (e: any) {
        oauthOk = false;
        result.errors.push(`${table} delete error: ${e?.message}`);
      }
    }
    result.deleted.oauthTokens = oauthOk;
  } else {
    result.errors.push("Supabase config missing — skipped credential deletion");
  }

  // ── 4. S3: delete every object under browser-state/{userId}/ ───────────
  // (storage-state.json, outline-storage-state.json, crowdmark-storage-state.json, …)
  {
    const prefix = `browser-state/${userId}/`;
    let failed = false;
    let s3: S3Client | null = null;
    try {
      s3 = new S3Client({ region: S3_REGION });
    } catch (e: any) {
      failed = true;
      result.errors.push(`S3 client error: ${e?.message}`);
    }

    if (s3) {
      // 4a. List + batch delete the whole prefix (handles pagination).
      try {
        let continuationToken: string | undefined;
        do {
          const listed: any = await s3.send(
            new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken: continuationToken })
          );
          const keys = ((listed?.Contents ?? []) as Array<{ Key?: string }>)
            .map((o) => o.Key)
            .filter((k): k is string => !!k && k.startsWith(prefix));
          if (keys.length > 0) {
            const delRes: any = await s3.send(
              new DeleteObjectsCommand({
                Bucket: S3_BUCKET,
                Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
              })
            );
            for (const err of (delRes?.Errors ?? []) as Array<{ Key?: string; Code?: string; Message?: string }>) {
              failed = true;
              result.errors.push(`S3 delete error for ${err.Key}: ${err.Code ?? ""} ${err.Message ?? ""}`.trim());
            }
          }
          continuationToken = listed?.IsTruncated ? listed?.NextContinuationToken : undefined;
        } while (continuationToken);
      } catch (e: any) {
        // Fall through to the explicit per-key deletes below.
        failed = true;
        result.errors.push(`S3 list/batch delete error: ${e?.message}`);
      }

      // 4b. Always explicitly delete the known keys too, in case listing is
      // not permitted by the bucket policy or failed above.
      let knownOk = true;
      for (const name of ["storage-state.json", "outline-storage-state.json", "crowdmark-storage-state.json"]) {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: `${prefix}${name}` }));
        } catch (e: any) {
          if (e?.name !== "NoSuchKey") {
            knownOk = false;
            result.errors.push(`S3 delete error (${name}): ${e?.message}`);
          }
        }
      }
      // Report success only if nothing failed: after a list/batch failure,
      // objects other than the known keys may remain.
      result.deleted.s3State = !failed && knownOk;
    }
  }

  // ── 5. Disk: delete ~/.d2l-session-{userId} ──────────────────────────────
  try {
    const d2lPath = path.join(os.homedir(), `.d2l-session-${userId}`);
    await fs.rm(d2lPath, { recursive: true, force: true });
    result.deleted.diskD2lSession = true;
  } catch (e: any) {
    result.errors.push(`D2L disk session delete error: ${e?.message}`);
  }

  // ── 6. Disk: delete ~/.piazza-session-{userId} ───────────────────────────
  try {
    const piazzaPath = path.join(os.homedir(), `.piazza-session-${userId}`);
    await fs.rm(piazzaPath, { recursive: true, force: true });
    result.deleted.diskPiazzaSession = true;
  } catch (e: any) {
    result.errors.push(`Piazza disk session delete error: ${e?.message}`);
  }

  // ── 7. Disk: best-effort unlink of decrypted / saved temp state files ───
  // (s3Storage's storageStateTempPath files plus the fixed-name save temp
  // files; see isStorageStateTempFileFor for the exact patterns.)
  try {
    const tmp = os.tmpdir();
    const names = await fs.readdir(tmp).catch(() => [] as string[]);
    for (const name of names) {
      if (!isStorageStateTempFileFor(name, userId)) continue;
      await fs.rm(path.join(tmp, name), { force: true }).catch(() => {});
    }
    result.deleted.tmpFiles = true;
  } catch (e: any) {
    result.errors.push(`temp state file cleanup error: ${e?.message}`);
  }

  // ── Audit log ────────────────────────────────────────────────────────────
  await logCredentialAccess(userId, "all", "delete", "deleteAllUserData");

  return result;
}
