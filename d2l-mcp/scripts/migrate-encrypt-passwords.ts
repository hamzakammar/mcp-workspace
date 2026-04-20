#!/usr/bin/env tsx
/**
 * One-time migration: encrypt all plaintext passwords in user_credentials.
 *
 * Run ONCE after deploying the KMS encryption code:
 *   cd d2l-mcp && npx tsx scripts/migrate-encrypt-passwords.ts
 *
 * Safe to re-run — already-encrypted rows (prefix "enc:kms:v1:") are skipped.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   KMS_KEY_ARN
 *   AWS_REGION (optional, defaults to us-east-1)
 */

import "dotenv/config";
import { encryptPassword, isEncrypted } from "../src/utils/kms.js";

const sbUrl = process.env.SUPABASE_URL;
const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!sbUrl || !sbKey) {
  console.error("FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}

if (!process.env.KMS_KEY_ARN) {
  console.error("FATAL: KMS_KEY_ARN must be set.");
  process.exit(1);
}

const headers = {
  apikey: sbKey,
  Authorization: `Bearer ${sbKey}`,
  "Content-Type": "application/json",
};

interface CredentialRow {
  user_id: string;
  service: string;
  password: string | null;
}

async function fetchRows(): Promise<CredentialRow[]> {
  const resp = await fetch(
    `${sbUrl}/rest/v1/user_credentials?password=not.is.null&select=user_id,service,password`,
    { headers }
  );
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} — ${await resp.text()}`);
  return resp.json();
}

async function updatePassword(userId: string, service: string, encryptedPassword: string): Promise<void> {
  const resp = await fetch(
    `${sbUrl}/rest/v1/user_credentials?user_id=eq.${encodeURIComponent(userId)}&service=eq.${encodeURIComponent(service)}`,
    {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({ password: encryptedPassword }),
    }
  );
  if (!resp.ok) throw new Error(`Update failed for ${service}/${userId}: ${resp.status} — ${await resp.text()}`);
}

async function main() {
  console.log("Fetching user_credentials rows with non-null passwords...");
  const rows = await fetchRows();
  console.log(`Found ${rows.length} row(s) with passwords.`);

  let encrypted = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    if (!row.password) {
      skipped++;
      continue;
    }

    if (isEncrypted(row.password)) {
      console.log(`  [SKIP] ${row.service}/${row.user_id.slice(0, 8)}... — already encrypted`);
      skipped++;
      continue;
    }

    try {
      const encryptedPw = await encryptPassword(row.password);
      await updatePassword(row.user_id, row.service, encryptedPw);
      console.log(`  [OK]   ${row.service}/${row.user_id.slice(0, 8)}... — encrypted`);
      encrypted++;
    } catch (e: any) {
      console.error(`  [ERR]  ${row.service}/${row.user_id.slice(0, 8)}... — ${e.message}`);
      errors++;
    }
  }

  console.log("\nMigration complete.");
  console.log(`  Encrypted: ${encrypted}`);
  console.log(`  Skipped (already encrypted): ${skipped}`);
  console.log(`  Errors: ${errors}`);

  if (errors > 0) {
    console.error("\nSome rows failed to encrypt. Re-run the script to retry failures.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
