/**
 * One-time migration: re-encrypt all legacy (unencrypted) S3 browser states
 * into the current envelope encryption format.
 *
 * This fixes the issue where rejectIfLegacy=true in sessionRefresher and auth.ts
 * blocks loading legacy states, preventing auto-refresh for all users who were
 * onboarded before envelope encryption was introduced.
 *
 * Usage:
 *   npx tsx scripts/migrate-encrypt-s3-states.ts
 *
 * Requires environment variables:
 *   AWS_REGION, S3_BUCKET, KMS_KEY_ARN
 */

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { encryptEnvelope, isEncryptedEnvelope } from "../src/utils/kms.js";

const S3_BUCKET = process.env.S3_BUCKET || "study-mcp-notes";
const S3_REGION = process.env.AWS_REGION || "us-east-1";
const KMS_KEY_ARN = process.env.KMS_KEY_ARN;

if (!KMS_KEY_ARN) {
  console.error("ERROR: KMS_KEY_ARN must be set");
  process.exit(1);
}

const s3 = new S3Client({ region: S3_REGION });

async function migrate() {
  console.log(`Scanning s3://${S3_BUCKET}/browser-state/ for legacy objects...`);

  let continuationToken: string | undefined;
  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  do {
    const listResp = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: "browser-state/",
      ContinuationToken: continuationToken,
    }));

    for (const obj of listResp.Contents || []) {
      const key = obj.Key!;
      try {
        const getResp = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
        const rawBytes = await getResp.Body?.transformToByteArray();
        if (!rawBytes || rawBytes.length === 0) {
          skipped++;
          continue;
        }

        const data = Buffer.from(rawBytes);

        if (isEncryptedEnvelope(data)) {
          skipped++;
          continue;
        }

        // Legacy unencrypted state — encrypt it
        const plaintext = data.toString("utf-8");

        // Validate it's actually JSON (storage state format)
        try {
          JSON.parse(plaintext);
        } catch {
          console.warn(`  SKIP ${key} — not valid JSON`);
          skipped++;
          continue;
        }

        // Use the S3 object metadata captured_at if available, otherwise use LastModified
        const capturedAt = getResp.Metadata?.captured_at
          ? new Date(getResp.Metadata.captured_at)
          : obj.LastModified ?? new Date();

        const encryptedBody = await encryptEnvelope(plaintext, capturedAt);

        await s3.send(new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Body: encryptedBody,
          ContentType: "application/octet-stream",
          Metadata: {
            captured_at: capturedAt.toISOString(),
            migrated_from_legacy: "true",
          },
        }));

        migrated++;
        console.log(`  MIGRATED ${key} (captured ${capturedAt.toISOString()})`);
      } catch (e: any) {
        errors++;
        console.error(`  ERROR ${key}: ${e.message}`);
      }
    }

    continuationToken = listResp.NextContinuationToken;
  } while (continuationToken);

  console.log(`\nDone: ${migrated} migrated, ${skipped} already encrypted/skipped, ${errors} errors`);
}

migrate().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
