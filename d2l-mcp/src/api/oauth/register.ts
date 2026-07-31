/**
 * Dynamic Client Registration (RFC 7591) — POST /register.
 *
 * Zero-setup registration so clients like Sentience can obtain a client_id
 * without manual configuration. Redirect URIs are validated strictly.
 * Public clients (token_endpoint_auth_method=none) get no secret and must use
 * PKCE; confidential clients receive a one-time client_secret.
 */

import { Router, Request, Response } from "express";
import { generateToken, sha256hex, isValidRedirectUriForRegistration } from "./crypto.js";
import { createClient } from "./store.js";
import { SCOPE } from "./config.js";

const router = Router();

router.post("/register", async (req: Request, res: Response) => {
  const body = req.body || {};
  const redirectUris: unknown = body.redirect_uris;

  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    res.status(400).json({
      error: "invalid_redirect_uri",
      error_description: "redirect_uris is required and must be a non-empty array",
    });
    return;
  }

  for (const uri of redirectUris) {
    if (typeof uri !== "string" || !isValidRedirectUriForRegistration(uri)) {
      res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: `Invalid redirect_uri: ${String(uri)}`,
      });
      return;
    }
  }

  // Only the authorization_code + refresh_token grants are supported.
  const requestedGrants: string[] = Array.isArray(body.grant_types) && body.grant_types.length
    ? body.grant_types
    : ["authorization_code", "refresh_token"];
  const grantTypes = requestedGrants.filter((g) => g === "authorization_code" || g === "refresh_token");
  if (!grantTypes.includes("authorization_code")) grantTypes.unshift("authorization_code");

  // Default to a public (PKCE) client — that's what Sentience/mcp clients use.
  const authMethod: string = body.token_endpoint_auth_method === "client_secret_post"
    || body.token_endpoint_auth_method === "client_secret_basic"
    ? body.token_endpoint_auth_method
    : "none";

  const clientId = "hzn_client_" + generateToken("").slice(0, 32);
  const now = Math.floor(Date.now() / 1000);

  let clientSecret: string | null = null;
  let clientSecretHash: string | null = null;
  if (authMethod !== "none") {
    clientSecret = generateToken("hzn_cs_");
    clientSecretHash = sha256hex(clientSecret);
  }

  try {
    await createClient({
      client_id: clientId,
      client_secret_hash: clientSecretHash,
      client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 200) : null,
      redirect_uris: redirectUris as string[],
      grant_types: grantTypes,
      response_types: ["code"],
      scope: SCOPE,
      token_endpoint_auth_method: authMethod,
    });
  } catch (e: any) {
    console.error("[OAUTH] client registration failed:", e?.message || e);
    res.status(500).json({ error: "server_error", error_description: "Failed to register client" });
    return;
  }

  const response: Record<string, unknown> = {
    client_id: clientId,
    client_id_issued_at: now,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: ["code"],
    token_endpoint_auth_method: authMethod,
    scope: SCOPE,
  };
  if (typeof body.client_name === "string") response.client_name = body.client_name;
  if (clientSecret) {
    response.client_secret = clientSecret; // shown once, never stored in plaintext
    response.client_secret_expires_at = 0; // does not expire
  }

  res.status(201).json(response);
});

export default router;
