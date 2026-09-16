/**
 * Client authentication for the token/revocation endpoints.
 * Supports public clients (none, PKCE-only), client_secret_post, and
 * client_secret_basic.
 */

import type { Request } from "express";
import { sha256hex, safeEqual } from "./crypto.js";
import type { OAuthClient } from "./store.js";

export interface ClientCredentials {
  clientId: string | null;
  clientSecret: string | null;
}

/** Extract client credentials from an Authorization: Basic header or body. */
export function extractClientCredentials(req: Request): ClientCredentials {
  const auth = (req.headers["authorization"] || req.headers["Authorization"]) as string | undefined;
  if (auth && auth.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      if (idx >= 0) {
        return {
          clientId: decodeURIComponent(decoded.slice(0, idx)),
          clientSecret: decodeURIComponent(decoded.slice(idx + 1)),
        };
      }
    } catch {
      /* fall through to body */
    }
  }
  const body = req.body || {};
  return {
    clientId: typeof body.client_id === "string" ? body.client_id : null,
    clientSecret: typeof body.client_secret === "string" ? body.client_secret : null,
  };
}

/**
 * Verify that the presented credentials authenticate the given client.
 * Public clients (token_endpoint_auth_method=none) are authenticated by
 * client_id + PKCE alone. Confidential clients must present a matching secret.
 */
export function verifyClientAuth(client: OAuthClient, creds: ClientCredentials): boolean {
  if (client.token_endpoint_auth_method === "none") {
    return true; // PKCE provides proof-of-possession for public clients
  }
  if (!creds.clientSecret || !client.client_secret_hash) return false;
  return safeEqual(sha256hex(creds.clientSecret), client.client_secret_hash);
}
