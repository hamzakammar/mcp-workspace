/**
 * D2L Auth routes — browser streaming for Duo MFA login.
 *
 * POST /auth/d2l/start         — Start a VNC browser session, returns vncUrl
 * GET  /auth/d2l/status        — Check session status (waiting/authenticated/failed)
 * GET  /vnc/assets/*           — noVNC client (static, cacheable, shared by all sessions)
 * WS   /vnc/:sessionId/websockify — VNC stream (upgrade handled in index.ts)
 */

import express, { Router, Request, Response } from "express";
import { BrowserSessionManager, NOVNC_ASSET_PATH } from "../browser/BrowserSessionManager.js";
import { authMiddleware } from "./auth.js";
import { resolveAllowedD2LHost, normalizeD2LHost, getAllowedD2LHosts, DEFAULT_D2L_HOST } from "../utils/d2lHost.js";
import { OUTLINE_HOST_MAP } from "../config/outlineHosts.js";

const router = Router();

/** Outline hostnames we will drive a browser to: those mapped from an allowed D2L host. */
function allowedOutlineHosts(): Map<string, string> {
  const out = new Map<string, string>(); // outline host -> d2l host
  for (const d2lHost of getAllowedD2LHosts()) {
    const base = OUTLINE_HOST_MAP[d2lHost]?.outlineBase;
    if (!base) continue;
    try { out.set(new URL(base).hostname.toLowerCase(), d2lHost); } catch { /* bad config entry */ }
  }
  return out;
}

/**
 * Resolve a user-supplied outline host to a canonical allowed hostname, or
 * null. Missing input defaults to the outline site for DEFAULT_D2L_HOST.
 * Prevents /auth/outline/start from steering the headless browser anywhere.
 */
export function resolveAllowedOutlineHost(raw: unknown): string | null {
  const allowed = allowedOutlineHosts();
  let candidate: unknown = raw;
  if (candidate === undefined || candidate === null || candidate === "") {
    const base = OUTLINE_HOST_MAP[DEFAULT_D2L_HOST]?.outlineBase;
    if (!base) return null;
    candidate = base;
  }
  const host = normalizeD2LHost(candidate);
  return host !== null && allowed.has(host) ? host : null;
}

function resolvePublicHost(req: Request): string {
  // Explicit override for production launch hardening.
  const override = process.env.PUBLIC_BASE_HOST?.trim();
  if (override) return override;

  const forwardedHost = (req.headers["x-forwarded-host"] as string | undefined)?.trim();
  const hostHeader = (req.headers["host"] as string | undefined)?.trim();
  const reqHost = req.hostname?.trim();
  const host = forwardedHost || hostHeader || reqHost || process.env.API_HOST || "localhost";
  const normalized = host.split(",")[0].trim().replace(/:\d+$/, "");

  return normalized;
}

/**
 * POST /auth/d2l/start
 * Body: { d2lHost?: string }
 * Returns: { sessionId, vncUrl, message }
 */
router.post("/auth/d2l/start", authMiddleware, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const d2lHost = resolveAllowedD2LHost(req.body?.d2lHost || DEFAULT_D2L_HOST);
  if (!d2lHost) {
    res.status(400).json({ error: "Unsupported D2L host" });
    return;
  }

  try {
    const reqHost = resolvePublicHost(req);
    const { sessionId, vncUrl } = await BrowserSessionManager.startSession(userId, d2lHost, reqHost);
    res.json({
      sessionId,
      vncUrl,
      message: "Open the vncUrl in your browser to log into D2L. The session will close automatically once you're logged in.",
    });
  } catch (err: any) {
    console.error("[AUTH] Failed to start browser session:", err);
    res.status(500).json({ error: err.message || "Failed to start browser session" });
  }
});

/**
 * GET /auth/d2l/status
 * Returns current session status for the authenticated user.
 */
router.get("/auth/d2l/status", authMiddleware, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const session = BrowserSessionManager.getSessionForUser(userId);

  if (!session) {
    res.json({ status: "no_session" });
    return;
  }

  res.json({
    sessionId: session.sessionId,
    status: session.status,
    vncUrl: session.vncUrl,
    createdAt: session.createdAt,
  });
});

/**
 * GET /auth/d2l/status/:sessionId
 * Returns status for a specific session (used by onboarding page polling).
 * No auth required — sessionId is the secret.
 */
router.get("/auth/d2l/status/:sessionId", async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const session = BrowserSessionManager.getSession(sessionId);

  if (!session) {
    res.json({ status: "no_session" });
    return;
  }

  res.json({
    sessionId: session.sessionId,
    status: session.status,
    createdAt: session.createdAt,
  });
});

/**
 * POST /auth/outline/start
 * Body: { outlineHost?: string }
 * Returns: { sessionId, vncUrl, message }
 */
router.post("/auth/outline/start", authMiddleware, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const outlineHost = resolveAllowedOutlineHost(req.body?.outlineHost);
  if (!outlineHost) {
    res.status(400).json({ error: "Unsupported outline host" });
    return;
  }

  try {
    const reqHost = resolvePublicHost(req);
    const { sessionId, vncUrl } = await BrowserSessionManager.startOutlineSession(userId, outlineHost, reqHost);
    res.json({
      sessionId,
      vncUrl,
      message: "Open the vncUrl in your browser to log into the course outline portal. The session will close automatically once you're logged in.",
    });
  } catch (err: any) {
    console.error("[AUTH] Failed to start outline browser session:", err);
    res.status(500).json({ error: err.message || "Failed to start outline browser session" });
  }
});

/**
 * GET /auth/outline/status/:sessionId
 * Returns status for a specific outline session (used by dashboard polling).
 * No auth required — sessionId is the secret.
 */
router.get("/auth/outline/status/:sessionId", async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const session = BrowserSessionManager.getSession(sessionId);

  if (!session) {
    res.json({ status: "no_session" });
    return;
  }

  res.json({
    sessionId: session.sessionId,
    status: session.status,
    createdAt: session.createdAt,
  });
});

/**
 * POST /auth/crowdmark/start
 * Returns: { sessionId, vncUrl, message }
 */
router.post("/auth/crowdmark/start", authMiddleware, async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    const reqHost = resolvePublicHost(req);
    const { sessionId, vncUrl } = await BrowserSessionManager.startCrowdmarkSession(userId, reqHost);
    res.json({
      sessionId,
      vncUrl,
      message: "Open the vncUrl in your browser to log into Crowdmark. The session will close automatically once you're logged in.",
    });
  } catch (err: any) {
    console.error("[AUTH] Failed to start Crowdmark browser session:", err);
    res.status(500).json({ error: err.message || "Failed to start Crowdmark browser session" });
  }
});

/**
 * GET /auth/crowdmark/status/:sessionId
 * No auth required — sessionId is the secret.
 */
router.get("/auth/crowdmark/status/:sessionId", async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const session = BrowserSessionManager.getSession(sessionId);
  if (!session) { res.json({ status: "no_session" }); return; }
  res.json({ sessionId: session.sessionId, status: session.status, createdAt: session.createdAt });
});

/**
 * noVNC client files. Served straight from disk instead of through each
 * session's websockify (which forked a Python process per file and made the
 * ~70-module client crawl). Identical for every session, so let browsers cache.
 */
router.use(
  NOVNC_ASSET_PATH,
  express.static(process.env.NOVNC_DIR || "/usr/share/novnc", { maxAge: "1d", index: false }),
);

/**
 * Legacy per-session URLs (/vnc/:sessionId/vnc.html?...) from links issued
 * before the asset path moved — redirect to the shared client.
 */
router.get("/vnc/:sessionId/vnc.html", (req: Request, res: Response) => {
  const { sessionId } = req.params;
  if (!BrowserSessionManager.getLiveSession(sessionId)) {
    res.status(404).send("Session not found or expired. Start a new login from the Horizon dashboard.");
    return;
  }
  const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  res.redirect(302, `${NOVNC_ASSET_PATH}/vnc.html${qs}`);
});

export default router;
