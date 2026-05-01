/**
 * Shared S3 helpers for browser storage state persistence.
 * Used by BrowserSessionManager (VNC flow), sessionRefresher (headless auto-refresh),
 * and auth.ts (silent re-login).
 *
 * Security: all storage state is encrypted at the application layer using
 * AES-256-GCM with a KMS-generated data key (envelope encryption).
 * Legacy unencrypted objects are detected and used as-is until the next
 * successful auth re-writes them in the encrypted format.
 *
 * TTL: storage state older than STORAGE_STATE_MAX_AGE_DAYS is treated as
 * expired. The caller receives `undefined` and the normal reauth flow kicks in.
 * captured_at is stored both inside the authenticated envelope (tamper-proof)
 * and in S3 object metadata (so the daily TTL job can check age without decrypting).
 */

import path from "path";
import os from "os";
import fs from "fs/promises";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import {
  encryptEnvelope,
  decryptEnvelope,
  isEncryptedEnvelope,
  readEnvelopeCapturedAt,
  KMS_KEY_ARN,
} from "./kms.js";
import { logCredentialAccess } from "./auditLog.js";

const S3_BUCKET = process.env.S3_BUCKET || "study-mcp-notes";
const S3_REGION = process.env.AWS_REGION || "us-east-1";

/** Storage state older than this many days is treated as expired. */
export const STORAGE_STATE_MAX_AGE_DAYS = 25;

const s3 = new S3Client({ region: S3_REGION });

function storageStateKey(userId: string, service?: string): string {
  // 'd2l' (default) keeps the original key for backward compatibility.
  if (!service || service === 'd2l') return `browser-state/${userId}/storage-state.json`;
  return `browser-state/${userId}/${service}-storage-state.json`;
}

function isStateExpired(capturedAt: string): boolean {
  const ageMs = Date.now() - new Date(capturedAt).getTime();
  return ageMs > STORAGE_STATE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Download and decrypt browser storage state from S3.
 * Returns the local temp file path on success, or `undefined` if:
 *   - the object does not exist
 *   - the state is expired (> STORAGE_STATE_MAX_AGE_DAYS days old)
 *   - decryption fails
 */
export async function loadStorageStateFromS3(
  userId: string,
  service?: string,
  opts?: { rejectIfLegacy?: boolean }
): Promise<string | undefined> {
  const key = storageStateKey(userId, service);
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    const rawBytes = await res.Body?.transformToByteArray();
    if (!rawBytes || rawBytes.length === 0) return undefined;

    const data = Buffer.from(rawBytes);

    if (isEncryptedEnvelope(data)) {
      // ── Encrypted envelope (current format) ──────────────────────────
      const capturedAt = readEnvelopeCapturedAt(data);
      if (capturedAt && isStateExpired(capturedAt)) {
        console.error(
          `[S3] Storage state for user ${userId} expired (captured ${capturedAt}). ` +
          `Treating as not found — duo reauth required.`
        );
        return undefined;
      }

      const { plaintext } = await decryptEnvelope(data);
      const tmpPath = path.join(os.tmpdir(), `browser-state-${userId}.json`);
      await fs.writeFile(tmpPath, plaintext, "utf-8");
      console.error(`[S3] Loaded and decrypted browser storage state for user ${userId}`);

      await logCredentialAccess(userId, "s3_state", "read", "loadStorageStateFromS3");
      return tmpPath;

    } else {
      // ── Legacy unencrypted object ─────────────────────────────────────
      if (opts?.rejectIfLegacy) {
        // Callers like the session refresher use this to avoid launching a headless browser
        // with stale unencrypted state — which would trigger a real Duo push notification.
        console.error(
          `[S3] Rejecting legacy unencrypted storage state for user ${userId} (rejectIfLegacy=true). ` +
          `Caller should proceed without browser state.`
        );
        return undefined;
      }

      // Check TTL using the captured_at S3 object metadata before serving.
      const legacyCapturedAt = res.Metadata?.captured_at;
      if (legacyCapturedAt && isStateExpired(legacyCapturedAt)) {
        console.error(
          `[S3] Legacy storage state for user ${userId} is expired (captured ${legacyCapturedAt}). ` +
          `Treating as not found — duo reauth required.`
        );
        return undefined;
      }

      console.error(
        `[S3] WARNING: storage state for user ${userId} is unencrypted (legacy). ` +
        `Will be re-encrypted on next successful auth.`
      );
      const plaintext = data.toString("utf-8");
      const tmpPath = path.join(os.tmpdir(), `browser-state-${userId}.json`);
      await fs.writeFile(tmpPath, plaintext, "utf-8");

      await logCredentialAccess(userId, "s3_state", "read", "loadStorageStateFromS3:legacy");
      return tmpPath;
    }
  } catch (e: any) {
    if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) {
      console.error(`[S3] No saved browser state for user ${userId}`);
    } else {
      console.error(`[S3] Failed to load browser state: ${e?.message}`);
    }
    return undefined;
  }
}

/**
 * Encrypt and upload browser storage state to S3.
 * The captured_at timestamp is embedded in the authenticated envelope and
 * also stored as S3 object metadata so the TTL job can check age cheaply.
 *
 * @param userId     The user ID.
 * @param statePath  Path to the local JSON file to upload.
 * @param capturedAt When the session was captured (defaults to now).
 */
export async function saveStorageStateToS3(
  userId: string,
  statePath: string,
  capturedAt?: Date,
  service?: string
): Promise<void> {
  const key = storageStateKey(userId, service);
  const captureTime = capturedAt ?? new Date();

  try {
    const plaintext = await fs.readFile(statePath, "utf-8");

    if (KMS_KEY_ARN) {
      // ── Encrypted path (production) ───────────────────────────────────
      const encryptedBody = await encryptEnvelope(plaintext, captureTime);
      await s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Body: encryptedBody,
          ContentType: "application/octet-stream",
          Metadata: {
            // Also stored in S3 metadata so the TTL job can HeadObject cheaply
            captured_at: captureTime.toISOString(),
          },
        })
      );
      console.error(`[S3] Encrypted and saved browser storage state for user ${userId}`);
    } else {
      // ── Unencrypted fallback (dev without KMS) ────────────────────────
      console.error(
        `[S3] WARNING: KMS_KEY_ARN not set — saving storage state UNENCRYPTED. ` +
        `Set KMS_KEY_ARN for production deployments.`
      );
      await s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Body: plaintext,
          ContentType: "application/json",
          Metadata: { captured_at: captureTime.toISOString() },
        })
      );
      console.error(`[S3] Saved browser storage state for user ${userId} (unencrypted)`);
    }

    await logCredentialAccess(userId, "s3_state", "write", "saveStorageStateToS3");
  } catch (e: any) {
    console.error(`[S3] Failed to save browser state: ${e?.message}`);
    throw e; // re-throw so callers know the save failed
  }
}

/**
 * Delete the browser storage state for a user from S3.
 * Used by deleteAllUserData. NoSuchKey is treated as success.
 */
export async function deleteStorageStateFromS3(userId: string): Promise<void> {
  const key = storageStateKey(userId);
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    console.error(`[S3] Deleted browser storage state for user ${userId}`);
  } catch (e: any) {
    if (e?.name !== "NoSuchKey") throw e;
  }
}

/**
 * Check the age of a user's S3 storage state without downloading or decrypting it.
 * Uses the captured_at S3 object metadata set by saveStorageStateToS3.
 * Returns null if the object doesn't exist or has no metadata.
 */
export async function getStorageStateCapturedAt(userId: string): Promise<Date | null> {
  const key = storageStateKey(userId);
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    const capturedAtStr = head.Metadata?.captured_at;
    if (!capturedAtStr) return null;
    return new Date(capturedAtStr);
  } catch (e: any) {
    if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}
