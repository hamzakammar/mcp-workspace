/**
 * OAuth server configuration.
 *
 * All public URLs derive from PUBLIC_BASE_URL (falling back to API_HOST, then
 * the known production host). The MCP resource is the single protected resource
 * this authorization server issues tokens for.
 */

export function getBaseUrl(): string {
  const explicit = process.env.PUBLIC_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.API_HOST) return `https://${process.env.API_HOST}`;
  return "https://horizon.hamzaammar.ca";
}

/** Issuer / authorization-server identifier. */
export function getIssuer(): string {
  return getBaseUrl();
}

/** The canonical MCP resource URL (RFC 8707 resource indicator / audience). */
export function getResourceUrl(): string {
  return `${getBaseUrl()}/mcp`;
}

/** The single scope this server supports. */
export const SCOPE = "horizon:mcp";

// Token / code lifetimes (seconds).
export const ACCESS_TOKEN_TTL = Number(process.env.OAUTH_ACCESS_TOKEN_TTL || 900); // 15 min
export const REFRESH_TOKEN_TTL = Number(process.env.OAUTH_REFRESH_TOKEN_TTL || 60 * 60 * 24 * 30); // 30 days
export const AUTH_CODE_TTL = Number(process.env.OAUTH_AUTH_CODE_TTL || 60); // 60 s

let warnedSessionSecretFallback = false;

/** HMAC secret used to sign the short-lived interim authorization-request blob
 * that travels between the login page (GET /authorize) and the consent POST.
 *
 * Production must set a dedicated OAUTH_SESSION_SECRET. We keep a STUDY_MCP_TOKEN
 * fallback only so local dev still boots — but it warns loudly (once) rather than
 * silently coupling two unrelated security purposes. */
export function getSessionSecret(): string {
  if (process.env.OAUTH_SESSION_SECRET) return process.env.OAUTH_SESSION_SECRET;

  const fallback = process.env.STUDY_MCP_TOKEN;
  if (!fallback) throw new Error("OAUTH_SESSION_SECRET required for OAuth (no fallback available)");

  if (!warnedSessionSecretFallback) {
    warnedSessionSecretFallback = true;
    console.warn(
      "[OAUTH] OAUTH_SESSION_SECRET is not set — falling back to STUDY_MCP_TOKEN. " +
        "Set a dedicated OAUTH_SESSION_SECRET; do not rely on this fallback in production."
    );
  }
  return fallback;
}
