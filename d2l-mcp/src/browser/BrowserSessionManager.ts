/**
 * BrowserSessionManager
 *
 * Manages per-user Playwright browser instances with noVNC streaming.
 * Each user gets an isolated browser + Xvfb display + websockify port.
 *
 * Flow:
 *   1. startSession(userId, d2lHost) → returns { sessionId, vncUrl }
 *   2. User opens vncUrl, logs into D2L, approves Duo
 *   3. Playwright detects successful login, captures cookies
 *   4. Full browser storage state (all cookies incl. ADFS) saved to S3
 *   5. D2L session cookies stored to Supabase for MCP tool use
 *   6. Session auto-closes after success or 10min timeout
 *
 *   On next session start: S3 state is restored → ADFS cookie skips Duo
 *   (valid for ~30-90 days depending on university IdP config)
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";
import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { supabase } from "../utils/supabase.js";
import { clearDuoRequired } from "../auth.js";

const SESSIONS_BASE = process.env.SESSIONS_PATH || "/tmp/sessions";
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const VNC_BASE_PORT = 5900;
const WS_BASE_PORT = 6080;
const S3_BUCKET = process.env.S3_BUCKET || "study-mcp-notes";
const S3_REGION = process.env.AWS_REGION || "us-east-1";

const s3 = new S3Client({ region: S3_REGION });

// Port pool — supports up to 50 concurrent auth sessions
const MAX_SESSIONS = 50;
const usedPorts = new Set<number>();

function allocatePort(base: number): number {
  for (let i = 0; i < MAX_SESSIONS; i++) {
    const port = base + i;
    if (!usedPorts.has(port)) {
      usedPorts.add(port);
      return port;
    }
  }
  throw new Error("No available ports for new browser session");
}

function releasePort(port: number) {
  usedPorts.delete(port);
}

export interface BrowserSession {
  sessionId: string;
  userId: string;
  d2lHost: string;
  vncUrl: string;
  wsPort: number;
  vncPort: number;
  displayNum: number;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  xvfbProc: ChildProcess;
  x11vncProc: ChildProcess;
  websockifyProc: ChildProcess;
  timeoutHandle: NodeJS.Timeout;
  status: "waiting" | "authenticated" | "failed" | "closed";
  createdAt: number;
}

const activeSessions = new Map<string, BrowserSession>();
const userSessionMap = new Map<string, string>(); // userId → sessionId

/** Wait until Xvfb's Unix socket exists (means it's ready to accept connections). */
async function waitForXvfb(displayNum: number, timeoutMs = 5000): Promise<void> {
  const socketPath = `/tmp/.X11-unix/X${displayNum}`;
  const { accessSync } = await import("fs");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      accessSync(socketPath);
      console.log(`[XVFB] display :${displayNum} ready`);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error(`Xvfb display :${displayNum} did not start within ${timeoutMs}ms`);
}

/** Download browser storage state from S3. Returns local temp path or undefined if not found. */
async function loadStorageStateFromS3(userId: string): Promise<string | undefined> {
  const key = `browser-state/${userId}/storage-state.json`;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    const body = await res.Body?.transformToString();
    if (!body) return undefined;
    const tmpPath = path.join(os.tmpdir(), `browser-state-${userId}.json`);
    await fs.writeFile(tmpPath, body);
    console.error(`[VNC] Loaded browser storage state from S3 for user ${userId}`);
    return tmpPath;
  } catch (e: any) {
    if (e?.name === "NoSuchKey") {
      console.error(`[VNC] No saved browser state for user ${userId} — fresh session`);
    } else {
      console.error(`[VNC] Failed to load browser state from S3: ${e?.message}`);
    }
    return undefined;
  }
}

/** Upload full browser storage state to S3 (persists ADFS + D2L cookies). */
async function saveStorageStateToS3(userId: string, statePath: string): Promise<void> {
  const key = `browser-state/${userId}/storage-state.json`;
  try {
    const body = await fs.readFile(statePath, "utf-8");
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: "application/json",
    }));
    console.error(`[VNC] Saved browser storage state to S3 for user ${userId}`);
  } catch (e: any) {
    console.error(`[VNC] Failed to save browser state to S3: ${e?.message}`);
  }
}

export class BrowserSessionManager {

  /**
   * Start a new browser session for a user.
   * Restores previous ADFS/D2L cookies from S3 — skips Duo if session still valid.
   * Returns the noVNC URL the user should open.
   */
  static async startSession(userId: string, d2lHost: string, apiHost?: string): Promise<{ sessionId: string; vncUrl: string }> {
    // Close any existing session for this user
    const existingId = userSessionMap.get(userId);
    if (existingId) {
      await BrowserSessionManager.closeSession(existingId);
    }

    const sessionId = randomUUID();
    const displayNum = 10 + activeSessions.size; // :10, :11, etc.
    const vncPort = allocatePort(VNC_BASE_PORT);
    const wsPort = allocatePort(WS_BASE_PORT);

    // 1. Start Xvfb virtual display
    const xvfbProc = spawn("Xvfb", [
      `:${displayNum}`,
      "-screen", "0", "1280x800x24",
      "-ac",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    xvfbProc.stdout?.on("data", (d: Buffer) => console.log(`[XVFB] ${d.toString().trim()}`));
    xvfbProc.stderr?.on("data", (d: Buffer) => console.error(`[XVFB] ${d.toString().trim()}`));
    xvfbProc.on("exit", (code) => console.error(`[XVFB :${displayNum}] exited with code ${code}`));

    await waitForXvfb(displayNum, 5000);

    // 2. Start x11vnc
    const x11vncProc = spawn("x11vnc", [
      "-display", `:${displayNum}`,
      "-rfbport", String(vncPort),
      "-nopw", "-shared", "-forever", "-quiet",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    x11vncProc.stderr?.on("data", (d: Buffer) => console.error(`[X11VNC] ${d.toString().trim()}`));
    x11vncProc.on("exit", (code) => console.error(`[X11VNC] exited with code ${code}`));

    await new Promise(r => setTimeout(r, 300));

    // 3. Start websockify (noVNC WebSocket proxy)
    const websockifyProc = spawn("websockify", [
      "--web", "/usr/share/novnc",
      String(wsPort),
      `localhost:${vncPort}`,
    ], { stdio: "ignore" });

    await new Promise(r => setTimeout(r, 300));

    // 4. Load saved storage state from S3 (restores ADFS session, skips Duo if still valid)
    const storageStatePath = await loadStorageStateFromS3(userId);

    // 5. Launch Playwright browser
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
      headless: false,
      env: { ...process.env, DISPLAY: `:${displayNum}` },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        `--display=:${displayNum}`,
        "--window-size=1280,800",
        "--window-position=0,0",
      ],
    });

    const context = await browser.newContext({
      storageState: storageStatePath,
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();
    await page.goto(`https://${d2lHost}`);

    // 6. Session timeout
    const timeoutHandle = setTimeout(async () => {
      console.error(`[VNC] Session ${sessionId} timed out for user ${userId}`);
      const s = activeSessions.get(sessionId);
      if (s) {
        s.status = "failed";
        await BrowserSessionManager.closeSession(sessionId);
      }
    }, SESSION_TIMEOUT_MS);

    const session: BrowserSession = {
      sessionId, userId, d2lHost,
      vncUrl: `https://${apiHost || process.env.API_HOST || "localhost"}/vnc/${sessionId}/vnc.html?autoconnect=true&reconnect=true&path=vnc/${sessionId}/websockify`,
      wsPort, vncPort, displayNum,
      browser, context, page,
      xvfbProc, x11vncProc, websockifyProc,
      timeoutHandle,
      status: "waiting",
      createdAt: Date.now(),
    };

    activeSessions.set(sessionId, session);
    userSessionMap.set(userId, sessionId);

    // 7. Watch for login
    BrowserSessionManager._watchForLogin(sessionId, userId, d2lHost, page, context);

    console.error(`[VNC] Started session ${sessionId} for user ${userId} on display :${displayNum}, wsPort ${wsPort}`);
    return { sessionId, vncUrl: session.vncUrl };
  }

  /**
   * Poll every 2s for a successful D2L login.
   */
  private static _watchForLogin(
    sessionId: string,
    userId: string,
    d2lHost: string,
    page: Page,
    context: BrowserContext
  ) {
    const interval = setInterval(async () => {
      const session = activeSessions.get(sessionId);
      if (!session || session.status !== "waiting") {
        clearInterval(interval);
        return;
      }
      try {
        const url = page.url();
        const isLoggedIn = (
          url.includes("/d2l/home") ||
          url.includes("/d2l/le/") ||
          url.includes("/d2l/lp/") ||
          (url.includes(d2lHost) && !url.includes("/login") && !url.includes("/auth"))
        );
        if (isLoggedIn) {
          clearInterval(interval);
          await BrowserSessionManager._captureAndStore(sessionId, userId, d2lHost, context);
        }
      } catch {
        // Page navigating — ignore
      }
    }, 2000);
  }

  /**
   * Capture cookies + storage state, persist to S3 and Supabase.
   */
  private static async _captureAndStore(
    sessionId: string,
    userId: string,
    d2lHost: string,
    context: BrowserContext
  ) {
    const session = activeSessions.get(sessionId);
    if (!session) return;

    try {
      console.error(`[VNC] Login detected for user ${userId}, capturing cookies...`);

      // Extract D2L session cookies for MCP API use
      const cookies = await context.cookies();
      const sessionVal = cookies.find(c => c.name === "d2lSessionVal" && c.domain.includes(d2lHost))?.value;
      const secureVal = cookies.find(c => c.name === "d2lSecureSessionVal" && c.domain.includes(d2lHost))?.value;

      if (!sessionVal || !secureVal) {
        console.error(`[VNC] Missing D2L session cookies for user ${userId} — still waiting`);
        session.status = "waiting";
        BrowserSessionManager._watchForLogin(sessionId, userId, d2lHost, session.page, context);
        return;
      }

      // Validate cookies by making a test D2L API call before storing
      try {
        const testUrl = `https://${d2lHost}/d2l/api/lp/1.43/users/whoami`;
        const testResp = await fetch(testUrl, {
          headers: { "Cookie": `d2lSessionVal=${sessionVal}; d2lSecureSessionVal=${secureVal}` },
          redirect: "manual",
        });
        if (testResp.status === 403 || testResp.status === 302) {
          console.error(`[VNC] Captured cookies are stale (status ${testResp.status}) for user ${userId} — forcing fresh login`);
          // Clear S3 state so next session forces real login
          try {
            const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
            await s3.send(new DeleteObjectCommand({
              Bucket: S3_BUCKET,
              Key: `browser-state/${userId}/storage-state.json`,
            }));
            console.error(`[VNC] Deleted stale S3 browser state for user ${userId}`);
          } catch (e: any) {
            console.error(`[VNC] Failed to delete S3 state: ${e?.message}`);
          }
          session.status = "waiting";
          // Navigate to login page to force fresh auth
          try {
            await session.page.goto(`https://${d2lHost}/d2l/login`, { timeout: 10000 });
          } catch {}
          BrowserSessionManager._watchForLogin(sessionId, userId, d2lHost, session.page, context);
          return;
        }
        console.error(`[VNC] Cookie validation passed (status ${testResp.status}) for user ${userId}`);
      } catch (valErr: any) {
        console.error(`[VNC] Cookie validation error: ${valErr.message} — storing anyway`);
      }

      // Save FULL storage state (all cookies incl. ADFS) to S3 for session resumption
      const tmpStatePath = path.join(os.tmpdir(), `storage-state-${sessionId}.json`);
      await context.storageState({ path: tmpStatePath });
      await saveStorageStateToS3(userId, tmpStatePath);
      await fs.unlink(tmpStatePath).catch(() => {});

      // Store D2L session token in Supabase for MCP tool use
      // Use direct REST API — Supabase JS client has known issues in ECS
      const token = JSON.stringify({ d2lSessionVal: sessionVal, d2lSecureSessionVal: secureVal });
      const sbUrl = process.env.SUPABASE_URL;
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

      if (sbUrl && sbKey) {
        try {
          // Upsert via REST API with Prefer: resolution=merge-duplicates
          const restUrl = `${sbUrl}/rest/v1/user_credentials`;
          const upsertResp = await fetch(restUrl, {
            method: "POST",
            headers: {
              "apikey": sbKey,
              "Authorization": `Bearer ${sbKey}`,
              "Content-Type": "application/json",
              "Prefer": "resolution=merge-duplicates",
            },
            body: JSON.stringify({
              user_id: userId,
              service: "d2l",
              host: d2lHost,
              token,
              updated_at: new Date().toISOString(),
            }),
          });
          if (!upsertResp.ok) {
            const errText = await upsertResp.text();
            console.error(`[VNC] Failed to store credentials via REST for user ${userId}: ${upsertResp.status} ${errText}`);
          } else {
            console.error(`[VNC] Successfully stored D2L credentials for user ${userId}`);
          }
        } catch (restErr: any) {
          console.error(`[VNC] REST API error storing credentials for user ${userId}:`, restErr.message);
        }
      } else {
        console.error(`[VNC] Missing SUPABASE_URL or key — cannot store D2L credentials`);
      }

      session.status = "authenticated";

      // Clear the duo_required flag since we just successfully re-authed
      await clearDuoRequired(userId).catch(() => {});

      // Close after 3s so user can see the logged-in state
      setTimeout(() => BrowserSessionManager.closeSession(sessionId), 3000);

    } catch (err) {
      console.error(`[VNC] Error capturing cookies for user ${userId}:`, err);
      session.status = "failed";
      await BrowserSessionManager.closeSession(sessionId);
    }
  }

  static getSession(sessionId: string): BrowserSession | undefined {
    return activeSessions.get(sessionId);
  }

  static getSessionForUser(userId: string): BrowserSession | undefined {
    const sessionId = userSessionMap.get(userId);
    return sessionId ? activeSessions.get(sessionId) : undefined;
  }

  static async closeSession(sessionId: string) {
    const session = activeSessions.get(sessionId);
    if (!session) return;

    clearTimeout(session.timeoutHandle);

    try { await session.browser.close(); } catch {}
    try { session.websockifyProc.kill("SIGTERM"); } catch {}
    try { session.x11vncProc.kill("SIGTERM"); } catch {}
    try { session.xvfbProc.kill("SIGTERM"); } catch {}

    releasePort(session.vncPort);
    releasePort(session.wsPort);

    // Keep in map 60s so status poll can see final authenticated state
    setTimeout(() => {
      activeSessions.delete(sessionId);
      userSessionMap.delete(session.userId);
    }, 60_000);

    console.error(`[VNC] Closed session ${sessionId} for user ${session.userId}`);
  }

  static async closeAll() {
    const ids = [...activeSessions.keys()];
    await Promise.all(ids.map(id => BrowserSessionManager.closeSession(id)));
  }
}
