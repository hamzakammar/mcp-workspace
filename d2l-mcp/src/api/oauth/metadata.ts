/**
 * OAuth discovery metadata under the standard .well-known routes.
 *
 *  - /.well-known/oauth-protected-resource        (RFC 9728 / MCP)
 *  - /.well-known/oauth-protected-resource/mcp     (resource-specific variant)
 *  - /.well-known/oauth-authorization-server       (RFC 8414)
 *
 * These MUST be reachable without a token so a client can discover the flow.
 */

import { Router, Request, Response } from "express";
import { getBaseUrl, getIssuer, getResourceUrl, SCOPE } from "./config.js";

const router = Router();

function protectedResourceMetadata() {
  return {
    resource: getResourceUrl(),
    authorization_servers: [getIssuer()],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_documentation: `${getBaseUrl()}/onboard`,
  };
}

function authorizationServerMetadata() {
  const base = getBaseUrl();
  return {
    issuer: getIssuer(),
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    revocation_endpoint: `${base}/revoke`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
  };
}

const noStore = (res: Response) => res.setHeader("Cache-Control", "no-store");

router.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
  noStore(res);
  res.json(protectedResourceMetadata());
});

// Resource-specific variant (some clients append the resource path).
router.get("/.well-known/oauth-protected-resource/mcp", (_req: Request, res: Response) => {
  noStore(res);
  res.json(protectedResourceMetadata());
});

router.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
  noStore(res);
  res.json(authorizationServerMetadata());
});

// Some clients also probe the resource-suffixed AS metadata path.
router.get("/.well-known/oauth-authorization-server/mcp", (_req: Request, res: Response) => {
  noStore(res);
  res.json(authorizationServerMetadata());
});

export default router;
export { protectedResourceMetadata, authorizationServerMetadata };
