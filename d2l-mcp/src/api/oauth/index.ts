/**
 * OAuth 2.1 authorization server for the Horizon MCP transport.
 *
 * Combines the discovery, registration, authorization, token, and revocation
 * endpoints into a single router mounted publicly (no JWT/API-key required —
 * these endpoints are how a client discovers and completes the OAuth flow).
 *
 * OAuth is a SECONDARY auth method: it maps onto the existing Horizon user
 * model (Supabase auth.users id) and produces the same authenticated user
 * context (X-User-Id → runWithUserId → getUserId) as the API-key path.
 */

import { Router } from "express";
import metadataRouter from "./metadata.js";
import registerRouter from "./register.js";
import authorizeRouter from "./authorize.js";
import tokenRouter from "./token.js";
import revokeRouter from "./revoke.js";

const router = Router();

router.use(metadataRouter);
router.use(registerRouter);
router.use(authorizeRouter);
router.use(tokenRouter);
router.use(revokeRouter);

export default router;
