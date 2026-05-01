/**
 * D2L Auth routes — browser streaming for Duo MFA login.
 *
 * POST /auth/d2l/start         — Start a VNC browser session, returns vncUrl
 * GET  /auth/d2l/status        — Check session status (waiting/authenticated/failed)
 * GET  /vnc/:sessionId/*       — Proxy noVNC static files + WebSocket
 */

import { Router, Request, Response } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { BrowserSessionManager } from "../browser/BrowserSessionManager.js";
import { authMiddleware } from "./auth.js";

const router = Router();

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
  const d2lHost = (req.body?.d2lHost as string) || process.env.D2L_HOST || "learn.uwaterloo.ca";

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
  const outlineHost = (req.body?.outlineHost as string) || "outline.uwaterloo.ca";

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
 * Dynamic noVNC WebSocket proxy.
 * Route: /vnc/:sessionId/websockify
 * Proxies to the user's websockify port.
 */
router.use("/vnc/:sessionId/websockify", (req: Request, res: Response, next) => {
  const { sessionId } = req.params;
  const session = BrowserSessionManager.getSession(sessionId);

  if (!session) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }

  const proxy = createProxyMiddleware({
    target: `http://localhost:${session.wsPort}`,
    ws: true,
    changeOrigin: true,
    pathRewrite: { [`^/vnc/${sessionId}/websockify`]: "/" },
    on: {
      error: (err) => console.error("[VNC proxy error]", err),
    },
  });

  proxy(req, res, next);
});

/**
 * Serve noVNC static files for a session.
 * Route: /vnc/:sessionId/*
 */
router.use("/vnc/:sessionId", (req: Request, res: Response, next) => {
  const { sessionId } = req.params;
  const session = BrowserSessionManager.getSession(sessionId);

  if (!session) {
    res.status(404).send("Session not found or expired");
    return;
  }

  const proxy = createProxyMiddleware({
    target: `http://localhost:${session.wsPort}`,
    changeOrigin: true,
    pathRewrite: (path) => path.replace(`/vnc/${sessionId}`, ""),
    on: {
      error: (err) => console.error("[VNC static proxy error]", err),
    },
  });

  proxy(req, res, next);
});

export default router;
