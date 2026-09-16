/**
 * Pure crypto helpers for the OAuth server: token generation, hashing,
 * PKCE S256 verification, redirect-URI validation, and signing of the
 * interim authorization-request blob. No I/O — unit-testable in isolation.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getSessionSecret } from "./config.js";

/** Generate an opaque token with the given prefix (e.g. "hzn_at_"). */
export function generateToken(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url");
}

/** SHA-256 hex — the only form in which secrets/codes/tokens are stored.
 * Matches the api_keys hashing used by the gateway. */
export function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a PKCE code_verifier against a stored S256 challenge.
 * challenge === base64url(sha256(verifier)). S256 only — plain is rejected.
 */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  // RFC 7636: verifier must be 43-128 chars from the unreserved set.
  if (verifier.length < 43 || verifier.length > 128) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return safeEqual(computed, challenge);
}

/**
 * Strict redirect-URI validation: exact string match against a registered URI.
 * No substring/prefix matching, no wildcards.
 */
export function isRegisteredRedirectUri(registered: string[], provided: string): boolean {
  if (!provided) return false;
  return registered.some((uri) => uri === provided);
}

/**
 * Validate that a redirect URI is well-formed and acceptable to register.
 * Allows https:// for web clients and http://localhost|127.0.0.1 for native/
 * loopback clients (per OAuth 2.0 for Native Apps). Rejects fragments.
 */
export function isValidRedirectUriForRegistration(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1")) {
    return true;
  }
  // Custom/private-use URI schemes (e.g. "com.example.app:/cb") are allowed for
  // native clients as long as they carry a scheme and no fragment.
  if (u.protocol && u.protocol !== "http:" && u.protocol !== "https:") return true;
  return false;
}

// ── Interim authorization-request signing (login page → consent POST) ───────
// We avoid server-side pending state by carrying the (validated) authorization
// request as a signed, short-lived blob through the login form.

export interface AuthRequest {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  state?: string;
  resource?: string;
  exp: number; // unix seconds
}

export function signAuthRequest(req: AuthRequest): string {
  const payload = Buffer.from(JSON.stringify(req)).toString("base64url");
  const sig = createHmac("sha256", getSessionSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyAuthRequest(blob: string): AuthRequest | null {
  const dot = blob.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = blob.slice(0, dot);
  const sig = blob.slice(dot + 1);
  const expected = createHmac("sha256", getSessionSecret()).update(payload).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const req = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AuthRequest;
    if (!req.exp || Math.floor(Date.now() / 1000) > req.exp) return null;
    return req;
  } catch {
    return null;
  }
}
