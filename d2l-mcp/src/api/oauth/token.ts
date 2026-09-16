/**
 * Token endpoint (RFC 6749 §4.1.3 + §6, RFC 7636) — POST /token.
 *
 * Supports grant_type=authorization_code (PKCE S256 required, code single-use)
 * and grant_type=refresh_token (with refresh-token rotation). Issues opaque,
 * short-lived bearer access tokens. Nothing sensitive is logged.
 */

import { Router, Request, Response } from "express";
import { generateToken, sha256hex, verifyPkceS256, safeEqual } from "./crypto.js";
import { extractClientCredentials, verifyClientAuth } from "./clientAuth.js";
import {
  getClient,
  consumeAuthCode,
  saveAccessToken,
  saveRefreshToken,
  getRefreshToken,
  revokeRefreshToken,
} from "./store.js";
import { getResourceUrl, SCOPE, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL } from "./config.js";

const router = Router();

function tokenError(res: Response, status: number, error: string, description?: string): void {
  res.status(status)
    .set("Cache-Control", "no-store")
    .set("Pragma", "no-cache")
    .json({ error, ...(description ? { error_description: description } : {}) });
}

/** Issue an access token (+ refresh token) for a user/client, returning the
 * standard token response. */
async function issueTokens(opts: {
  clientId: string;
  userId: string;
  scope: string;
  resource: string | null;
  rotatedFrom?: string | null;
}) {
  const accessToken = generateToken("hzn_at_");
  const refreshToken = generateToken("hzn_rt_");
  const now = Date.now();

  await saveAccessToken({
    token_hash: sha256hex(accessToken),
    client_id: opts.clientId,
    user_id: opts.userId,
    scope: opts.scope,
    resource: opts.resource,
    expires_at: new Date(now + ACCESS_TOKEN_TTL * 1000).toISOString(),
  });
  await saveRefreshToken({
    token_hash: sha256hex(refreshToken),
    client_id: opts.clientId,
    user_id: opts.userId,
    scope: opts.scope,
    resource: opts.resource,
    rotated_from: opts.rotatedFrom ?? null,
    expires_at: new Date(now + REFRESH_TOKEN_TTL * 1000).toISOString(),
  });

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: refreshToken,
    scope: opts.scope,
  };
}

router.post("/token", async (req: Request, res: Response) => {
  const body = req.body || {};
  const grantType = body.grant_type;

  const creds = extractClientCredentials(req);

  if (grantType === "authorization_code") {
    const code = String(body.code || "");
    const redirectUri = String(body.redirect_uri || "");
    const codeVerifier = String(body.code_verifier || "");
    const clientId = creds.clientId || (typeof body.client_id === "string" ? body.client_id : "");

    if (!code || !redirectUri || !codeVerifier || !clientId) {
      tokenError(res, 400, "invalid_request", "Missing code, redirect_uri, code_verifier, or client_id");
      return;
    }

    const client = await getClient(clientId);
    if (!client) {
      tokenError(res, 401, "invalid_client", "Unknown client");
      return;
    }
    if (!verifyClientAuth(client, creds)) {
      tokenError(res, 401, "invalid_client", "Client authentication failed");
      return;
    }

    // Atomically consume the code (single-use / replay protection).
    let row;
    try {
      row = await consumeAuthCode(sha256hex(code));
    } catch (e: any) {
      console.error("[OAUTH] consumeAuthCode failed:", e?.message || e);
      tokenError(res, 500, "server_error");
      return;
    }
    if (!row) {
      tokenError(res, 400, "invalid_grant", "Authorization code is invalid or already used");
      return;
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      tokenError(res, 400, "invalid_grant", "Authorization code expired");
      return;
    }
    if (!safeEqual(row.client_id, clientId)) {
      tokenError(res, 400, "invalid_grant", "Code was issued to a different client");
      return;
    }
    if (!safeEqual(row.redirect_uri, redirectUri)) {
      tokenError(res, 400, "invalid_grant", "redirect_uri mismatch");
      return;
    }
    if (!verifyPkceS256(codeVerifier, row.code_challenge)) {
      tokenError(res, 400, "invalid_grant", "PKCE verification failed");
      return;
    }

    try {
      const tokens = await issueTokens({
        clientId,
        userId: row.user_id,
        scope: row.scope || SCOPE,
        resource: row.resource ?? getResourceUrl(),
      });
      res.set("Cache-Control", "no-store").set("Pragma", "no-cache").json(tokens);
    } catch (e: any) {
      console.error("[OAUTH] issueTokens (code) failed:", e?.message || e);
      tokenError(res, 500, "server_error");
    }
    return;
  }

  if (grantType === "refresh_token") {
    const refreshToken = String(body.refresh_token || "");
    const clientId = creds.clientId || (typeof body.client_id === "string" ? body.client_id : "");
    if (!refreshToken || !clientId) {
      tokenError(res, 400, "invalid_request", "Missing refresh_token or client_id");
      return;
    }

    const client = await getClient(clientId);
    if (!client) {
      tokenError(res, 401, "invalid_client", "Unknown client");
      return;
    }
    if (!verifyClientAuth(client, creds)) {
      tokenError(res, 401, "invalid_client", "Client authentication failed");
      return;
    }

    const oldHash = sha256hex(refreshToken);
    let row;
    try {
      row = await getRefreshToken(oldHash);
    } catch (e: any) {
      console.error("[OAUTH] getRefreshToken failed:", e?.message || e);
      tokenError(res, 500, "server_error");
      return;
    }
    if (!row || row.revoked || new Date(row.expires_at).getTime() < Date.now()) {
      tokenError(res, 400, "invalid_grant", "Refresh token is invalid, expired, or revoked");
      return;
    }
    if (!safeEqual(row.client_id, clientId)) {
      tokenError(res, 400, "invalid_grant", "Refresh token was issued to a different client");
      return;
    }

    try {
      // Rotate: revoke the presented refresh token, then issue a fresh pair.
      await revokeRefreshToken(oldHash);
      const tokens = await issueTokens({
        clientId,
        userId: row.user_id,
        scope: row.scope || SCOPE,
        resource: row.resource ?? getResourceUrl(),
        rotatedFrom: oldHash,
      });
      res.set("Cache-Control", "no-store").set("Pragma", "no-cache").json(tokens);
    } catch (e: any) {
      console.error("[OAUTH] issueTokens (refresh) failed:", e?.message || e);
      tokenError(res, 500, "server_error");
    }
    return;
  }

  tokenError(res, 400, "unsupported_grant_type", "Only authorization_code and refresh_token are supported");
});

export default router;
