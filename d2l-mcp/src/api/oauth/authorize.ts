/**
 * Authorization endpoint (RFC 6749 §4.1 + PKCE) — GET and POST /authorize.
 *
 * GET  renders a combined login + consent page (reusing the existing Supabase
 *      email/password login) showing the requesting client and requested scope.
 * POST authenticates the user against Supabase, then issues a single-use,
 *      PKCE-bound authorization code and redirects back to the client.
 *
 * Redirect URIs are validated strictly against the registered set. PKCE S256
 * is required. The RFC 8707 resource parameter is validated against the MCP
 * resource URL.
 */

import { Router, Request, Response } from "express";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import {
  generateToken,
  sha256hex,
  isRegisteredRedirectUri,
  signAuthRequest,
  verifyAuthRequest,
  type AuthRequest,
} from "./crypto.js";
import { getClient, saveAuthCode } from "./store.js";
import { getResourceUrl, SCOPE, AUTH_CODE_TTL } from "./config.js";

const router = Router();

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase not configured");
  return createSupabaseClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/** Append an OAuth error to a validated redirect URI and return the full URL. */
function redirectWithError(redirectUri: string, state: string | undefined, error: string, desc?: string): string {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  if (desc) u.searchParams.set("error_description", desc);
  if (state) u.searchParams.set("state", state);
  return u.toString();
}

function renderErrorPage(res: Response, status: number, title: string, message: string): void {
  res.status(status).type("html").send(`<!doctype html><html><head><meta charset="utf-8">
<title>${esc(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#111}
h1{font-size:1.25rem}p{color:#444}</style></head>
<body><h1>${esc(title)}</h1><p>${esc(message)}</p></body></html>`);
}

function renderConsentPage(res: Response, opts: {
  clientName: string;
  scope: string;
  authRequestBlob: string;
  error?: string;
}): void {
  res.status(200).type("html").send(`<!doctype html><html><head><meta charset="utf-8">
<title>Authorize access — Horizon</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{color-scheme:light dark}
  body{font-family:system-ui,-apple-system,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1.25rem;color:#111}
  @media(prefers-color-scheme:dark){body{color:#eee;background:#111}}
  h1{font-size:1.25rem;margin-bottom:.25rem}
  .sub{color:#666;font-size:.9rem;margin-bottom:1.5rem}
  .card{border:1px solid #8883;border-radius:12px;padding:1rem 1.25rem;margin-bottom:1.25rem}
  .client{font-weight:600}
  .scope{display:inline-block;background:#6663;border-radius:6px;padding:.15rem .5rem;font-size:.8rem;margin-top:.5rem}
  label{display:block;font-size:.85rem;margin:.75rem 0 .25rem}
  input{width:100%;box-sizing:border-box;padding:.6rem .7rem;border:1px solid #8886;border-radius:8px;font-size:1rem;background:transparent;color:inherit}
  button{width:100%;margin-top:1.25rem;padding:.7rem;border:0;border-radius:8px;background:#4f46e5;color:#fff;font-size:1rem;font-weight:600;cursor:pointer}
  .err{color:#c0392b;font-size:.85rem;margin-top:.75rem}
</style></head>
<body>
  <h1>Authorize access to Horizon</h1>
  <div class="sub">Sign in to grant access to your Horizon study data.</div>
  <div class="card">
    <div><span class="client">${esc(opts.clientName)}</span> is requesting access to:</div>
    <span class="scope">${esc(opts.scope)}</span>
    <div class="sub" style="margin-top:.75rem;margin-bottom:0">This lets it read and act on your courses, tasks, and notes through the Horizon MCP tools on your behalf.</div>
  </div>
  <form method="POST" action="/authorize" autocomplete="off">
    <input type="hidden" name="auth_request" value="${esc(opts.authRequestBlob)}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required autocomplete="username">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" required autocomplete="current-password">
    ${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ""}
    <button type="submit">Sign in &amp; Authorize</button>
  </form>
</body></html>`);
}

// ── GET /authorize ────────────────────────────────────────────────────────────
router.get("/authorize", async (req: Request, res: Response) => {
  const q = req.query as Record<string, string>;
  const clientId = q.client_id;
  const redirectUri = q.redirect_uri;

  if (!clientId || !redirectUri) {
    renderErrorPage(res, 400, "Invalid request", "Missing client_id or redirect_uri.");
    return;
  }

  let client;
  try {
    client = await getClient(clientId);
  } catch (e: any) {
    console.error("[OAUTH] authorize getClient failed:", e?.message || e);
    renderErrorPage(res, 500, "Server error", "Could not load client.");
    return;
  }
  // Unknown client or unregistered redirect URI → DO NOT redirect (could be an
  // open-redirect / phishing attempt). Show an error page instead.
  if (!client) {
    renderErrorPage(res, 400, "Unknown client", "The client_id is not registered.");
    return;
  }
  if (!isRegisteredRedirectUri(client.redirect_uris, redirectUri)) {
    renderErrorPage(res, 400, "Invalid redirect URI", "redirect_uri does not match a registered value.");
    return;
  }

  // From here the redirect_uri is trusted, so protocol errors redirect back.
  if (q.response_type !== "code") {
    res.redirect(redirectWithError(redirectUri, q.state, "unsupported_response_type", "Only response_type=code is supported"));
    return;
  }
  if (!q.code_challenge || q.code_challenge_method !== "S256") {
    res.redirect(redirectWithError(redirectUri, q.state, "invalid_request", "PKCE with code_challenge_method=S256 is required"));
    return;
  }
  const scope = q.scope || SCOPE;
  if (scope.split(/\s+/).some((s) => s && s !== SCOPE)) {
    res.redirect(redirectWithError(redirectUri, q.state, "invalid_scope", `Only '${SCOPE}' is supported`));
    return;
  }
  if (q.resource && q.resource !== getResourceUrl()) {
    res.redirect(redirectWithError(redirectUri, q.state, "invalid_target", "resource does not match this MCP server"));
    return;
  }

  const authReq: AuthRequest = {
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: q.code_challenge,
    code_challenge_method: "S256",
    scope: SCOPE,
    state: q.state,
    resource: q.resource || getResourceUrl(),
    exp: Math.floor(Date.now() / 1000) + 600, // 10 min to complete login
  };

  renderConsentPage(res, {
    clientName: client.client_name || client.client_id,
    scope: SCOPE,
    authRequestBlob: signAuthRequest(authReq),
  });
});

// ── POST /authorize ───────────────────────────────────────────────────────────
router.post("/authorize", async (req: Request, res: Response) => {
  const body = req.body || {};
  const authReq = verifyAuthRequest(String(body.auth_request || ""));
  if (!authReq) {
    renderErrorPage(res, 400, "Session expired", "Your authorization session expired. Please restart the connection from your client.");
    return;
  }

  // Re-validate the client + redirect URI against the DB (defence in depth).
  let client;
  try {
    client = await getClient(authReq.client_id);
  } catch (e: any) {
    console.error("[OAUTH] authorize POST getClient failed:", e?.message || e);
    renderErrorPage(res, 500, "Server error", "Could not load client.");
    return;
  }
  if (!client || !isRegisteredRedirectUri(client.redirect_uris, authReq.redirect_uri)) {
    renderErrorPage(res, 400, "Invalid request", "Client or redirect URI is no longer valid.");
    return;
  }

  const email = String(body.email || "");
  const password = String(body.password || "");
  if (!email || !password) {
    renderConsentPage(res, {
      clientName: client.client_name || client.client_id,
      scope: SCOPE,
      authRequestBlob: signAuthRequest(authReq),
      error: "Email and password are required.",
    });
    return;
  }

  // Authenticate against the existing Supabase login.
  let userId: string;
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user?.id) {
      renderConsentPage(res, {
        clientName: client.client_name || client.client_id,
        scope: SCOPE,
        authRequestBlob: signAuthRequest(authReq),
        error: "Invalid email or password.",
      });
      return;
    }
    userId = data.user.id;
  } catch (e: any) {
    console.error("[OAUTH] authorize sign-in error:", e?.message || e);
    renderErrorPage(res, 500, "Server error", "Login failed. Please try again.");
    return;
  }

  // Issue a single-use authorization code bound to client + PKCE + user + resource.
  const code = generateToken("hzn_ac_");
  try {
    await saveAuthCode({
      code_hash: sha256hex(code),
      client_id: authReq.client_id,
      user_id: userId,
      redirect_uri: authReq.redirect_uri,
      code_challenge: authReq.code_challenge,
      code_challenge_method: "S256",
      scope: SCOPE,
      resource: authReq.resource ?? getResourceUrl(),
      expires_at: new Date(Date.now() + AUTH_CODE_TTL * 1000).toISOString(),
    });
  } catch (e: any) {
    console.error("[OAUTH] failed to persist auth code:", e?.message || e);
    res.redirect(redirectWithError(authReq.redirect_uri, authReq.state, "server_error", "Could not issue authorization code"));
    return;
  }

  const u = new URL(authReq.redirect_uri);
  u.searchParams.set("code", code);
  if (authReq.state) u.searchParams.set("state", authReq.state);
  res.redirect(u.toString());
});

export default router;
