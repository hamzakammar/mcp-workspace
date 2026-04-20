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

-- Invalidate all existing keys (they were plaintext-stored and must be rotated)
DELETE FROM api_keys;

-- Drop the plaintext key column
ALTER TABLE api_keys DROP COLUMN IF EXISTS key_value;
