-- Drop plaintext API key storage and invalidate all existing keys.
--
-- Previously api_keys.key_value stored the full plaintext key so it could
-- be re-displayed on new devices. This is a security risk: anyone with DB
-- access could retrieve all API keys.
--
-- After this migration:
--   - key_value column is removed
--   - All existing keys are deleted (they were stored in plaintext — treat as compromised)
--   - Users must regenerate their API key; new keys are shown once at creation, never stored
--   - Gateway auth continues to work via the key_hash (SHA-256) column

-- Invalidate all existing keys (they were plaintext-stored and must be rotated).
-- Guarded (2026-10-09): this migration was applied by hand and isn't recorded in
-- schema_migrations, so a later `supabase db push` would re-run it and wipe every
-- live (hash-only) key. Only delete while the plaintext column still exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'api_keys' AND column_name = 'key_value') THEN
    DELETE FROM api_keys;
  END IF;
END $$;

-- Drop the plaintext key column
ALTER TABLE api_keys DROP COLUMN IF EXISTS key_value;
