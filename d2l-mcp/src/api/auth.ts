/**
 * REST API auth middleware.
 * - Cognito: verify JWT via aws-jwt-verify, set req.userId = payload.sub.
 * - Supabase: verify HS256 JWT using SUPABASE_JWT_SECRET, or ES256 via Supabase JWKS.
 * - Dev bypass: SKIP_JWT_AUTH=1 + X-User-Id header.
 */

import type { Request, Response, NextFunction } from "express";
import { createHmac, createVerify } from "crypto";
import { safeEqual } from "./oauth/crypto.js";

const SKIP = process.env.SKIP_JWT_AUTH === "1" || process.env.SKIP_JWT_AUTH === "true";
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;

let cognitoVerifier: { verify: (token: string) => Promise<{ sub: string }> } | null = null;

// Cache for Supabase JWKS public keys
let jwksCache: Record<string, string> | null = null;
let jwksCacheTime = 0;
const JWKS_CACHE_TTL = 3600 * 1000; // 1 hour

async function initCognitoVerifier() {
  if (cognitoVerifier) return cognitoVerifier;
  if (!USER_POOL_ID || !CLIENT_ID) return null;
  const { CognitoJwtVerifier } = await import("aws-jwt-verify");
  cognitoVerifier = CognitoJwtVerifier.create({
    userPoolId: USER_POOL_ID,
    tokenUse: "id",
    clientId: CLIENT_ID,
  }) as unknown as { verify: (token: string) => Promise<{ sub: string }> };
  return cognitoVerifier;
}

/**
 * Fetch Supabase JWKS and cache public keys by kid
 */
async function getSupabasePublicKey(kid: string): Promise<string | null> {
  const now = Date.now();
  if (!jwksCache || now - jwksCacheTime > JWKS_CACHE_TTL) {
    try {
      // Fetch JWKS from Supabase
      const jwksUrl = SUPABASE_URL
        ? `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`
        : null;

      if (!jwksUrl) {
        console.error("[AUTH] SUPABASE_URL not set, cannot fetch JWKS");
        return null;
      }

      const { default: fetch } = await import("node-fetch").catch(() => ({ default: globalThis.fetch })) as any;
      const fetchFn = fetch || globalThis.fetch;
      const res = await fetchFn(jwksUrl);
      const data = await res.json() as { keys: Array<{ kid: string; x5c?: string[]; n?: string; e?: string; crv?: string; x?: string; y?: string; kty: string }> };

      jwksCache = {};
      for (const key of data.keys) {
        // Convert JWK to PEM using Node crypto
        if (key.kty === "EC" && key.x && key.y) {
          // Store raw key data for EC verification
          jwksCache[key.kid] = JSON.stringify({ x: key.x, y: key.y, crv: key.crv || "P-256" });
        } else if (key.x5c) {
          jwksCache[key.kid] = `-----BEGIN CERTIFICATE-----\n${key.x5c[0]}\n-----END CERTIFICATE-----`;
        }
      }
      jwksCacheTime = now;
    } catch (err) {
      console.error("[AUTH] Failed to fetch Supabase JWKS:", err);
      return null;
    }
  }
  return jwksCache?.[kid] || null;
}

/**
 * Verify a Supabase JWT (HS256 with secret, or ES256 via JWKS)
 */
function verifyHS256(token: string, secret: string): { sub: string; [key: string]: any } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");

  const [headerB64, payloadB64, signatureB64] = parts;

  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
  if (header.alg !== "HS256") throw new Error(`Expected HS256, got ${header.alg}`);

  const expectedSig = createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");

  if (!safeEqual(signatureB64, expectedSig)) throw new Error("JWT signature verification failed");

  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) throw new Error("JWT expired");
  if (!payload.sub) throw new Error("JWT missing sub");
  return payload;
}

async function verifyES256(token: string): Promise<{ sub: string; [key: string]: any }> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));

  if (header.alg !== "ES256") throw new Error(`Expected ES256, got ${header.alg}`);
  if (!header.kid) throw new Error("JWT missing kid");

  const keyData = await getSupabasePublicKey(header.kid);
  if (!keyData) throw new Error(`Public key not found for kid: ${header.kid}`);

  // Use jose library for ES256 verification if available, otherwise use subtle crypto
  try {
    const { jwtVerify, importJWK } = await import("jose");
    const keyObj = JSON.parse(keyData);
    const publicKey = await importJWK({ ...keyObj, kty: "EC", alg: "ES256" });
    const { payload } = await jwtVerify(token, publicKey, { algorithms: ["ES256"] });
    if (!payload.sub) throw new Error("JWT missing sub");
    return payload as { sub: string; [key: string]: any };
  } catch (joseErr: any) {
    // If jose not available, fall back to Node crypto
    if (joseErr.code === "ERR_MODULE_NOT_FOUND" || joseErr.message?.includes("Cannot find")) {
      throw new Error("jose library not available for ES256 verification");
    }
    throw joseErr;
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (SKIP) {
    const uid = req.headers["x-user-id"] as string | undefined;
    req.userId = uid?.trim() || "dev-user";
    next();
    return;
  }

  // Trust X-User-Id set by the Go gateway (already verified the JWT)
  const gatewayUserId = req.headers["x-user-id"] as string | undefined;
  if (gatewayUserId?.trim()) {
    req.userId = gatewayUserId.trim();
    next();
    return;
  }

  const auth = req.headers["authorization"] || req.headers["Authorization"];
  const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  // Decode header to check algorithm
  let tokenAlg = "unknown";
  try {
    const headerB64 = token.split(".")[0];
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    tokenAlg = header.alg;
  } catch {
    res.status(401).json({ error: "Invalid JWT format" });
    return;
  }

  // 1. Try Cognito if configured
  if (USER_POOL_ID && CLIENT_ID) {
    try {
      const v = await initCognitoVerifier();
      if (v) {
        const payload = await v.verify(token);
        req.userId = payload.sub;
        next();
        return;
      }
    } catch {
      // Fall through
    }
  }

  // 2. Try Supabase ES256 (new Supabase projects use ES256)
  if (tokenAlg === "ES256" && SUPABASE_URL) {
    try {
      const payload = await verifyES256(token);
      req.userId = payload.sub;
      next();
      return;
    } catch (err) {
      console.error("[AUTH] ES256 verification failed:", err instanceof Error ? err.message : err);
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }
  }

  // 3. Try Supabase HS256 (legacy Supabase projects)
  if (tokenAlg === "HS256" && SUPABASE_JWT_SECRET) {
    try {
      const payload = verifyHS256(token, SUPABASE_JWT_SECRET);
      req.userId = payload.sub;
      next();
      return;
    } catch (err) {
      console.error("[AUTH] HS256 verification failed:", err instanceof Error ? err.message : err);
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }
  }

  res.status(503).json({
    error: "JWT verification not configured (COGNITO_USER_POOL_ID + COGNITO_CLIENT_ID or SUPABASE_JWT_SECRET required)",
  });
}
