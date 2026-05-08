/**
 * Public auth routes for the onboarding page.
 * No JWT required — these handle signup/signin, return tokens, and OAuth callbacks.
 */

import { Router, Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { saveNotionToken } from "../study/notionAuth.js";

const router = Router();

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  // Use anon key for user auth — service role key issues short-lived tokens
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase not configured");
  return createClient(url, key);
}

/** POST /auth/signup */
router.post("/signup", async (req: Request, res: Response) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    res.status(400).json({ error: "Email and password required" });
    return;
  }
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) { res.status(400).json({ error: error.message }); return; }
    res.json({
      token: data.session?.access_token,
      refreshToken: data.session?.refresh_token,
      expiresAt: data.session?.expires_at,
      userId: data.user?.id,
      needsConfirmation: !data.session,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /auth/signin */
router.post("/signin", async (req: Request, res: Response) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    res.status(400).json({ error: "Email and password required" });
    return;
  }
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { res.status(400).json({ error: error.message }); return; }
    res.json({
      token: data.session?.access_token,
      refreshToken: data.session?.refresh_token,
      expiresAt: data.session?.expires_at,
      userId: data.user?.id,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /auth/refresh — exchange refresh_token for a new access_token */
router.post("/refresh", async (req: Request, res: Response) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    res.status(400).json({ error: "refreshToken required" });
    return;
  }
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error) { res.status(401).json({ error: error.message }); return; }
    res.json({
      token: data.session?.access_token,
      refreshToken: data.session?.refresh_token,
      expiresAt: data.session?.expires_at,
      userId: data.user?.id,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /auth/forgot-password — send password reset email */
router.post("/forgot-password", async (req: Request, res: Response) => {
  const { email, redirectTo } = req.body || {};
  if (!email) {
    res.status(400).json({ error: "Email required" });
    return;
  }
  try {
    const supabase = getSupabase();
    const forwardedProto = (req.headers["x-forwarded-proto"] as string | undefined) || "https";
    const host = req.headers.host;
    const origin = req.headers.origin as string | undefined;
    const fallbackBase = process.env.API_HOST ? `https://${process.env.API_HOST}` : "";
    const inferredBase = origin || (host ? `${forwardedProto}://${host}` : fallbackBase);
    const safeRedirect = (typeof redirectTo === "string" && redirectTo.trim()) || `${inferredBase}/onboard`;

    // Always return 200 to avoid account enumeration leakage.
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: safeRedirect });
    if (error) {
      console.error("[AUTH] forgot-password error:", error.message);
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /auth/reset-password — complete password recovery with tokens from email link */
router.post("/reset-password", async (req: Request, res: Response) => {
  const { accessToken, refreshToken, password } = req.body || {};
  if (!accessToken || !refreshToken || !password) {
    res.status(400).json({ error: "accessToken, refreshToken, and password required" });
    return;
  }
  if (typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }
  try {
    const supabase = getSupabase();
    const { error: sessionError } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (sessionError) {
      res.status(400).json({ error: sessionError.message });
      return;
    }

    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      res.status(400).json({ error: updateError.message });
      return;
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /auth/notion/callback — Notion OAuth callback.
 *
 * Notion redirects here after the user authorises the integration.
 * Exchanges the one-time `code` for an access token and stores it.
 * The `state` parameter encodes the userId so we know whose token to save.
 *
 * Security notes:
 *   - state is verified to contain a recent timestamp (< 10 min)
 *   - The Notion client secret is server-side only (never in the browser)
 */
router.get("/notion/callback", async (req: Request, res: Response) => {
  const { code, state, error: oauthError } = req.query as Record<string, string>;

  if (oauthError) {
    res.status(400).send(`Notion OAuth error: ${oauthError}`);
    return;
  }

  if (!code || !state) {
    res.status(400).send("Missing code or state parameter.");
    return;
  }

  // Decode and validate state
  let userId: string;
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
    userId = decoded.userId;
    const age = Date.now() - (decoded.ts ?? 0);
    if (!userId || age > 10 * 60 * 1000) {
      throw new Error("state expired or invalid");
    }
  } catch {
    res.status(400).send("Invalid state parameter. Please restart the connection flow.");
    return;
  }

  const clientId = process.env.NOTION_CLIENT_ID;
  const clientSecret = process.env.NOTION_CLIENT_SECRET;
  const redirectUri = process.env.NOTION_REDIRECT_URI
    || (process.env.API_HOST
      ? `https://${process.env.API_HOST}/auth/notion/callback`
      : 'https://horizon.hamzaammar.ca/auth/notion/callback');

  if (!clientId || !clientSecret) {
    res.status(500).send("Notion OAuth is not configured on this server.");
    return;
  }

  try {
    // Exchange code for access token
    const tokenResp = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResp.ok) {
      const body = await tokenResp.text();
      console.error("[NOTION_CALLBACK] Token exchange failed:", body);
      res.status(502).send("Failed to exchange Notion authorisation code. Please try again.");
      return;
    }

    const tokenData = await tokenResp.json() as { access_token: string };
    await saveNotionToken(userId, tokenData.access_token);

    // Redirect back to the onboard page with a success flag
    const onboardBase = process.env.API_HOST
      ? `https://${process.env.API_HOST}/onboard`
      : "https://horizon.hamzaammar.ca/onboard";
    res.redirect(`${onboardBase}?notion=connected`);
  } catch (e: any) {
    console.error("[NOTION_CALLBACK] Error:", e);
    res.status(500).send(`Internal error: ${e.message}`);
  }
});

export default router;
