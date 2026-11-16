/**
 * Persistence for the OAuth server. Uses the shared supabase client
 * (src/utils/supabase.ts) which works against both Supabase and a pg-pool
 * wrapper. Only wrapper-supported query patterns are used: select().eq().limit(),
 * insert().select(), update().eq().select(). Expiry is compared in JS.
 *
 * Tables come from migration 008_oauth.sql. All secrets/codes/tokens are
 * stored ONLY as SHA-256 hex hashes.
 */

import { supabase } from "../../utils/supabase.js";

export interface OAuthClient {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string | null;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  scope: string;
  token_endpoint_auth_method: string;
}

function toArray(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ── Clients ─────────────────────────────────────────────────────────────────

export async function createClient(rec: {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string | null;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  scope: string;
  token_endpoint_auth_method: string;
}): Promise<void> {
  const { error } = await supabase.from("oauth_clients").insert({
    client_id: rec.client_id,
    client_secret_hash: rec.client_secret_hash,
    client_name: rec.client_name,
    redirect_uris: JSON.stringify(rec.redirect_uris),
    grant_types: JSON.stringify(rec.grant_types),
    response_types: JSON.stringify(rec.response_types),
    scope: rec.scope,
    token_endpoint_auth_method: rec.token_endpoint_auth_method,
  });
  if (error) throw error;
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  const { data, error } = await supabase
    .from("oauth_clients")
    .select("*")
    .eq("client_id", clientId)
    .limit(1);
  if (error) throw error;
  const row = data?.[0];
  if (!row) return null;
  return {
    client_id: row.client_id,
    client_secret_hash: row.client_secret_hash ?? null,
    client_name: row.client_name ?? null,
    redirect_uris: toArray(row.redirect_uris),
    grant_types: toArray(row.grant_types),
    response_types: toArray(row.response_types),
    scope: row.scope ?? "horizon:mcp",
    token_endpoint_auth_method: row.token_endpoint_auth_method ?? "none",
  };
}

// ── Authorization codes ───────────────────────────────────────────────────────

export async function saveAuthCode(rec: {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  resource: string | null;
  expires_at: string; // ISO
}): Promise<void> {
  // Set consumed explicitly rather than relying on the column default.
  const { error } = await supabase.from("oauth_authorization_codes").insert({ ...rec, consumed: false });
  if (error) throw error;
}

export interface AuthCodeRow {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  resource: string | null;
  consumed: boolean;
  expires_at: string;
}

/**
 * Atomically consume an authorization code (single-use). Flips consumed=false
 * → true and returns the row only if it was still unconsumed. A second call
 * with the same code returns null (replay protection).
 */
export async function consumeAuthCode(codeHash: string): Promise<AuthCodeRow | null> {
  const { data, error } = await supabase
    .from("oauth_authorization_codes")
    .update({ consumed: true })
    .eq("code_hash", codeHash)
    .eq("consumed", false)
    .select("*");
  if (error) throw error;
  const row = data?.[0];
  if (!row) return null;
  return row as AuthCodeRow;
}

// ── Access tokens ─────────────────────────────────────────────────────────────

export async function saveAccessToken(rec: {
  token_hash: string;
  client_id: string;
  user_id: string;
  scope: string;
  resource: string | null;
  expires_at: string; // ISO
}): Promise<void> {
  const { error } = await supabase.from("oauth_access_tokens").insert({ ...rec, revoked: false });
  if (error) throw error;
}

export interface AccessTokenRow {
  token_hash: string;
  client_id: string;
  user_id: string;
  scope: string;
  resource: string | null;
  revoked: boolean;
  expires_at: string;
}

/** Resolve an access-token hash to its row (or null). Callers must check
 * revoked/expiry. (The gateway does the hot-path resolution in Go; this is
 * used by tests and any Node-side validation.) */
export async function getAccessToken(tokenHash: string): Promise<AccessTokenRow | null> {
  const { data, error } = await supabase
    .from("oauth_access_tokens")
    .select("*")
    .eq("token_hash", tokenHash)
    .limit(1);
  if (error) throw error;
  return (data?.[0] as AccessTokenRow) ?? null;
}

export async function revokeAccessToken(tokenHash: string): Promise<void> {
  const { error } = await supabase
    .from("oauth_access_tokens")
    .update({ revoked: true })
    .eq("token_hash", tokenHash);
  if (error) throw error;
}

// ── Refresh tokens ────────────────────────────────────────────────────────────

export async function saveRefreshToken(rec: {
  token_hash: string;
  client_id: string;
  user_id: string;
  scope: string;
  resource: string | null;
  rotated_from: string | null;
  expires_at: string; // ISO
}): Promise<void> {
  // created_at is set explicitly (the column also defaults to now()) so the
  // refresh-reuse grace window works the same against every backend.
  const { error } = await supabase
    .from("oauth_refresh_tokens")
    .insert({ ...rec, revoked: false, created_at: new Date().toISOString() });
  if (error) throw error;
}

export interface RefreshTokenRow {
  token_hash: string;
  client_id: string;
  user_id: string;
  scope: string;
  resource: string | null;
  revoked: boolean;
  expires_at: string;
}

export async function getRefreshToken(tokenHash: string): Promise<RefreshTokenRow | null> {
  const { data, error } = await supabase
    .from("oauth_refresh_tokens")
    .select("*")
    .eq("token_hash", tokenHash)
    .limit(1);
  if (error) throw error;
  return (data?.[0] as RefreshTokenRow) ?? null;
}

export async function revokeRefreshToken(tokenHash: string): Promise<void> {
  const { error } = await supabase
    .from("oauth_refresh_tokens")
    .update({ revoked: true })
    .eq("token_hash", tokenHash);
  if (error) throw error;
}

/**
 * Atomically consume a refresh token (single-use rotation). Flips
 * revoked=false → true and returns the row only if it was still unrevoked.
 * Concurrent refreshes with the same token: exactly one gets the row; the
 * others get null. Mirrors consumeAuthCode (works with the pg wrapper too:
 * update().eq().eq().select()).
 */
export async function consumeRefreshToken(tokenHash: string): Promise<RefreshTokenRow | null> {
  const { data, error } = await supabase
    .from("oauth_refresh_tokens")
    .update({ revoked: true })
    .eq("token_hash", tokenHash)
    .eq("revoked", false)
    .select("*");
  if (error) throw error;
  const row = data?.[0];
  if (!row) return null;
  return row as RefreshTokenRow;
}

/**
 * Revoke every still-active refresh and access token for a user+client pair.
 * Used for refresh-token reuse detection (RFC 6819 §5.2.2.3 / OAuth 2.1
 * §4.3.1) and when a refresh token is explicitly revoked (RFC 7009 §2.1).
 */
export async function revokeTokenFamily(userId: string, clientId: string): Promise<void> {
  const r1 = await supabase
    .from("oauth_refresh_tokens")
    .update({ revoked: true })
    .eq("user_id", userId)
    .eq("client_id", clientId)
    .eq("revoked", false)
    .select("token_hash");
  if (r1.error) throw r1.error;
  const r2 = await supabase
    .from("oauth_access_tokens")
    .update({ revoked: true })
    .eq("user_id", userId)
    .eq("client_id", clientId)
    .eq("revoked", false)
    .select("token_hash");
  if (r2.error) throw r2.error;
}

/** The refresh token that replaced `tokenHash` during rotation (or null).
 * Its created_at tells us when `tokenHash` was rotated. */
export async function getRotatedChild(
  tokenHash: string
): Promise<{ token_hash: string; created_at: string | null } | null> {
  const { data, error } = await supabase
    .from("oauth_refresh_tokens")
    .select("token_hash, created_at")
    .eq("rotated_from", tokenHash)
    .limit(1);
  if (error) throw error;
  const row = data?.[0];
  if (!row) return null;
  return { token_hash: row.token_hash, created_at: row.created_at ? String(row.created_at) : null };
}

/**
 * Undo consumeRefreshToken after a failed rotation (token issuance failed), so
 * a transient DB error doesn't log the user out. Callers must first check
 * that no rotated child exists.
 */
export async function unconsumeRefreshToken(tokenHash: string): Promise<void> {
  const { error } = await supabase
    .from("oauth_refresh_tokens")
    .update({ revoked: false })
    .eq("token_hash", tokenHash)
    .eq("revoked", true)
    .select("token_hash");
  if (error) throw error;
}
