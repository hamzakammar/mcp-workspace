/**
 * AWS KMS helpers for application-layer credential encryption.
 *
 * Passwords  → direct KMS Encrypt   (short values, always < 4 KB)
 *              stored as "enc:kms:v1:<base64-ciphertext>"
 *
 * S3 state   → envelope encryption  (arbitrary size: generate data key,
 *              AES-256-GCM encrypt locally, store KMS-encrypted data key
 *              alongside ciphertext)
 *
 * Both require KMS_KEY_ARN to be set in the environment. The server will
 * fail fast at startup if KMS_KEY_ARN is missing (see index.ts).
 */

import {
  KMSClient,
  EncryptCommand,
  DecryptCommand,
  GenerateDataKeyCommand,
} from "@aws-sdk/client-kms";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const KMS_KEY_ARN = process.env.KMS_KEY_ARN;
const AWS_REGION = process.env.AWS_REGION || "us-east-1";

/** Prefix that distinguishes KMS-encrypted passwords from legacy plaintext values. */
const ENC_PREFIX = "enc:kms:v1:";

function getKmsClient(): KMSClient {
  if (!KMS_KEY_ARN) {
    throw new Error(
      "KMS_KEY_ARN environment variable is not set. " +
        "Create an AWS KMS symmetric key and set KMS_KEY_ARN=<arn> " +
        "before starting the server."
    );
  }
  return new KMSClient({ region: AWS_REGION });
}

// ─────────────────────────────────────────────────────────────────────────────
// Password encryption (short values, direct KMS Encrypt API)
// ─────────────────────────────────────────────────────────────────────────────

/** Returns true if the value is already KMS-encrypted by this library. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

/**
 * Encrypt a short plaintext string (e.g. a password) with KMS.
 * Returns a string safe to store in any text column.
 *
 * `context` is a KMS Encryption Context (additional authenticated data). When set
 * (e.g. `{ userId, purpose: "d2l_password" }`) the exact same map is required to
 * decrypt, so a ciphertext stolen from one row cannot be decrypted as another user's
 * credential, and every KMS call is tagged with it in CloudTrail. Omitting it keeps
 * the legacy (unbound) behaviour for callers that have not opted in.
 */
export async function encryptPassword(
  plaintext: string,
  context?: Record<string, string>
): Promise<string> {
  const kms = getKmsClient();
  const { CiphertextBlob } = await kms.send(
    new EncryptCommand({
      KeyId: KMS_KEY_ARN!,
      Plaintext: Buffer.from(plaintext, "utf-8"),
      ...(context && Object.keys(context).length ? { EncryptionContext: context } : {}),
    })
  );
  if (!CiphertextBlob) throw new Error("[KMS] EncryptCommand returned no ciphertext");
  return ENC_PREFIX + Buffer.from(CiphertextBlob).toString("base64");
}

/**
 * Decrypt a value produced by encryptPassword.
 * Pass-through for values that are not yet encrypted (env-var fallback, legacy rows
 * before migration). These will be re-encrypted on the next write.
 *
 * `context` must match the Encryption Context used at encrypt time. For backward
 * compatibility, if a context is supplied but the decrypt fails (a legacy row was
 * encrypted WITHOUT a context, so KMS throws InvalidCiphertextException), we retry
 * once with no context. That legacy row re-encrypts WITH the context on its next save.
 * A context MISMATCH (e.g. another user's ciphertext) fails both attempts and throws —
 * which is the cross-user protection we want.
 */
export async function decryptPassword(
  ciphertext: string,
  context?: Record<string, string>
): Promise<string> {
  if (!isEncrypted(ciphertext)) {
    // Plaintext — return as-is. Will be encrypted on next credential write.
    return ciphertext;
  }
  const kms = getKmsClient();
  const blob = Buffer.from(ciphertext.slice(ENC_PREFIX.length), "base64");
  const hasContext = !!(context && Object.keys(context).length);
  try {
    const { Plaintext } = await kms.send(
      new DecryptCommand({
        CiphertextBlob: blob,
        ...(hasContext ? { EncryptionContext: context } : {}),
      })
    );
    if (!Plaintext) throw new Error("[KMS] DecryptCommand returned no plaintext");
    return Buffer.from(Plaintext).toString("utf-8");
  } catch (err) {
    if (hasContext) {
      // Legacy row encrypted before context binding — retry unbound. (A genuine
      // context mismatch from a different user's ciphertext also lands here and
      // fails again below, so it still cannot be decrypted.)
      const { Plaintext } = await kms.send(new DecryptCommand({ CiphertextBlob: blob }));
      if (!Plaintext) throw new Error("[KMS] DecryptCommand returned no plaintext");
      return Buffer.from(Plaintext).toString("utf-8");
    }
    throw err;
  }
}

/** KMS Encryption Context binding a stored D2L password to its owning user. */
export function d2lPasswordContext(userId: string): Record<string, string> {
  return { userId, purpose: "d2l_password" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Envelope encryption for large payloads (S3 browser state JSON)
// ─────────────────────────────────────────────────────────────────────────────

/** Internal shape of the encrypted envelope stored in S3. */
interface Envelope {
  /** Version marker — always 2 for this format. */
  v: 2;
  /** ISO-8601 timestamp of when the browser state was captured. */
  captured_at: string;
  /** Base64 of the KMS-encrypted AES-256 data key. */
  encrypted_key: string;
  /** Base64 of the 12-byte AES-GCM IV. */
  iv: string;
  /** Base64 of the 16-byte AES-GCM authentication tag. */
  auth_tag: string;
  /** Base64 of the AES-256-GCM ciphertext. */
  ciphertext: string;
}

export interface DecryptedEnvelope {
  plaintext: string;
  captured_at: string;
}

/**
 * Encrypt an arbitrary plaintext string (browser storage-state JSON) using
 * envelope encryption. Returns a Buffer suitable as the S3 PutObject Body.
 *
 * @param plaintext  The JSON string to encrypt.
 * @param capturedAt When the browser state was captured (defaults to now).
 */
export async function encryptEnvelope(
  plaintext: string,
  capturedAt?: Date
): Promise<Buffer> {
  const kms = getKmsClient();

  const { CiphertextBlob, Plaintext: rawDataKey } = await kms.send(
    new GenerateDataKeyCommand({ KeyId: KMS_KEY_ARN!, KeySpec: "AES_256" })
  );
  if (!CiphertextBlob || !rawDataKey) {
    throw new Error("[KMS] GenerateDataKey returned incomplete response");
  }

  const dataKey = Buffer.from(rawDataKey);
  const iv = randomBytes(12);

  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Zero the data key from memory after use
  dataKey.fill(0);

  const envelope: Envelope = {
    v: 2,
    captured_at: (capturedAt ?? new Date()).toISOString(),
    encrypted_key: Buffer.from(CiphertextBlob).toString("base64"),
    iv: iv.toString("base64"),
    auth_tag: authTag.toString("base64"),
    ciphertext: ct.toString("base64"),
  };

  return Buffer.from(JSON.stringify(envelope), "utf-8");
}

/**
 * Decrypt an envelope produced by encryptEnvelope.
 * Throws an error if the auth tag fails (tamper detection).
 */
export async function decryptEnvelope(data: Buffer): Promise<DecryptedEnvelope> {
  const envelope = JSON.parse(data.toString("utf-8")) as Envelope;

  if (envelope.v !== 2) {
    throw new Error(`[KMS] Unknown envelope version: ${(envelope as any).v}`);
  }

  const kms = getKmsClient();
  const encryptedKey = Buffer.from(envelope.encrypted_key, "base64");

  const { Plaintext: rawDataKey } = await kms.send(
    new DecryptCommand({ CiphertextBlob: encryptedKey })
  );
  if (!rawDataKey) throw new Error("[KMS] Envelope DecryptCommand returned no data key");

  const dataKey = Buffer.from(rawDataKey);
  const iv = Buffer.from(envelope.iv, "base64");
  const authTag = Buffer.from(envelope.auth_tag, "base64");
  const ct = Buffer.from(envelope.ciphertext, "base64");

  const decipher = createDecipheriv("aes-256-gcm", dataKey, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf-8");

  // Zero the data key from memory after use
  dataKey.fill(0);

  return { plaintext, captured_at: envelope.captured_at };
}

/**
 * Returns true if the Buffer looks like an encrypted envelope (not raw storage-state JSON).
 * Used to detect legacy unencrypted objects in S3.
 */
export function isEncryptedEnvelope(data: Buffer): boolean {
  try {
    const obj = JSON.parse(data.toString("utf-8"));
    return obj.v === 2 && typeof obj.encrypted_key === "string";
  } catch {
    return false;
  }
}

/**
 * Read captured_at from an envelope WITHOUT decrypting (for TTL checks).
 * Returns null if the data is not an envelope or has no captured_at.
 */
export function readEnvelopeCapturedAt(data: Buffer): string | null {
  try {
    const obj = JSON.parse(data.toString("utf-8"));
    if (obj.v === 2 && typeof obj.captured_at === "string") {
      return obj.captured_at;
    }
    return null;
  } catch {
    return null;
  }
}
