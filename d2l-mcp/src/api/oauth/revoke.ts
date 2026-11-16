/**
 * Token revocation (RFC 7009) — POST /revoke.
 *
 * Accepts an access or refresh token and revokes it. Per spec, the response is
 * always 200 (even for unknown tokens) to avoid leaking token validity.
 */

import { Router, Request, Response } from "express";
import { sha256hex, safeEqual } from "./crypto.js";
import { extractClientCredentials, verifyClientAuth } from "./clientAuth.js";
import {
  getClient,
  getAccessToken,
  getRefreshToken,
  revokeAccessToken,
  revokeRefreshToken,
  revokeTokenFamily,
} from "./store.js";

const router = Router();

router.post("/revoke", async (req: Request, res: Response) => {
  const body = req.body || {};
  const token = String(body.token || "");
  const hint = String(body.token_type_hint || "");

  if (!token) {
    res.status(400).json({ error: "invalid_request", error_description: "token is required" });
    return;
  }

  // Authenticate the client if it identifies itself; confidential clients must
  // present a valid secret. Unknown/absent client → still 200 (no info leak).
  const creds = extractClientCredentials(req);
  let authedClientId: string | null = null;
  if (creds.clientId) {
    try {
      const client = await getClient(creds.clientId);
      if (client && !verifyClientAuth(client, creds)) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }
      if (client) authedClientId = client.client_id;
    } catch (e: any) {
      // Can't establish which client is calling: don't fall back to
      // possession-only revocation; let the client retry.
      console.error("[OAUTH] revoke getClient failed:", e?.message || e);
      res.status(503).set("Retry-After", "5").json({ error: "temporarily_unavailable" });
      return;
    }
  }

  // RFC 7009 §2.1: the server verifies the token was issued to the client
  // making the request. If it was not, respond 200 and do nothing. When the
  // caller did not authenticate as a known client, fall back to the previous
  // behaviour (possession of the token is sufficient to revoke it).
  const ownedBy = (row: { client_id: string } | null): boolean =>
    !!row && (authedClientId === null || safeEqual(row.client_id, authedClientId));

  const hash = sha256hex(token);
  // Each returns true if the token exists in that table (owned or not).
  const tryAccess = async (): Promise<boolean> => {
    const row = await getAccessToken(hash);
    if (!row) return false;
    if (!ownedBy(row)) return true;
    await revokeAccessToken(hash);
    return true;
  };
  const tryRefresh = async (): Promise<boolean> => {
    const row = await getRefreshToken(hash);
    if (!row) return false;
    if (!ownedBy(row)) return true;
    await revokeRefreshToken(hash);
    // Revoking a refresh token also invalidates access tokens from the same
    // grant (RFC 7009 §2.1) — revoke the whole user+client family.
    await revokeTokenFamily(row.user_id, row.client_id);
    return true;
  };
  try {
    // The hint is only an optimisation: if the token is not found under the
    // hinted type, search the other one too (RFC 7009 §2.1).
    if (hint === "refresh_token") {
      if (!(await tryRefresh())) await tryAccess();
    } else {
      if (!(await tryAccess())) await tryRefresh();
    }
  } catch (e: any) {
    console.error("[OAUTH] revoke failed:", e?.message || e);
  }

  res.status(200).json({ ok: true });
});

export default router;
