-- Credential access audit log.
-- Records every read, write, and delete of a credential.
-- Never exposed to API clients — backend service-role only.
-- Rows are append-only; no update or delete policies are granted.

CREATE TABLE IF NOT EXISTS credential_access_log (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text        NOT NULL,
  credential_type text    NOT NULL,   -- 'd2l_password' | 'piazza_password' | 'd2l_token' | 'piazza_token' | 's3_state' | 'api_key' | 'all'
  action      text        NOT NULL,   -- 'read' | 'write' | 'delete' | 'encrypt' | 'decrypt'
  trigger     text        NOT NULL,   -- function or event name that caused the access
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cal_user_id     ON credential_access_log (user_id);
CREATE INDEX IF NOT EXISTS idx_cal_occurred_at ON credential_access_log (occurred_at DESC);

-- Enable RLS — only service_role (backend) can write; no client-level policies.
ALTER TABLE credential_access_log ENABLE ROW LEVEL SECURITY;

-- No SELECT / INSERT policies for authenticated users — access is backend-only.
-- The service_role_key bypasses RLS entirely, so the backend can always write.
