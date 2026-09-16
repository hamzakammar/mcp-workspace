/**
 * Token revocation (RFC 7009) — POST /revoke.
 *
 * Accepts an access or refresh token and revokes it. Per spec, the response is
 * always 200 (even for unknown tokens) to avoid leaking token validity.
 */

import { Router, Request, Response } from "express";
import { sha256hex } from "./crypto.js";
import { extractClientCredentials, verifyClientAuth } from "./clientAuth.js";
import { getClient, revokeAccessToken, revokeRefreshToken } from "./store.js";

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
  if (creds.clientId) {
    try {
      const client = await getClient(creds.clientId);
      if (client && !verifyClientAuth(client, creds)) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }
    } catch (e: any) {
      console.error("[OAUTH] revoke getClient failed:", e?.message || e);
    }
  }

  const hash = sha256hex(token);
  try {
    if (hint === "refresh_token") {
      await revokeRefreshToken(hash);
    } else if (hint === "access_token") {
      await revokeAccessToken(hash);
    } else {
      // No/unknown hint: attempt both.
      await revokeAccessToken(hash).catch(() => {});
      await revokeRefreshToken(hash).catch(() => {});
    }
  } catch (e: any) {
    console.error("[OAUTH] revoke failed:", e?.message || e);
  }

  res.status(200).json({ ok: true });
});

export default router;
