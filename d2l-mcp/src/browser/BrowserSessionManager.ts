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
import { supabase } from "../utils/supabase.js";
import { clearDuoRequired, markSessionValidated } from "../auth.js";
import { loadStorageStateFromS3, saveStorageStateToS3 } from "../utils/s3Storage.js";

const SESSIONS_BASE = process.env.SESSIONS_PATH || "/tmp/sessions";
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const VNC_BASE_PORT = 5900;
const WS_BASE_PORT = 6080;

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
  sessionType: 'd2l' | 'outline' | 'crowdmark';
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

// S3 storage state helpers are imported from utils/s3Storage.ts
// (loadStorageStateFromS3, saveStorageStateToS3) — encrypted + TTL-aware

export class BrowserSessionManager {

  /**
   * Shared helper: spins up Xvfb + x11vnc + websockify + Playwright and
   * returns a fully initialised BrowserSession (status="waiting").
   * Callers attach their own login watcher after this returns.
   */
  private static async _startVNCInfra(
    userId: string,
    targetUrl: string,
    apiHost: string | undefined,
    sessionType: 'd2l' | 'outline' | 'crowdmark',
  ): Promise<BrowserSession> {
    // Close any existing session for this user
    const existingId = userSessionMap.get(userId);
    if (existingId) await BrowserSessionManager.closeSession(existingId);

    const sessionId = randomUUID();
    const displayNum = 10 + activeSessions.size;
    const vncPort = allocatePort(VNC_BASE_PORT);
    const wsPort = allocatePort(WS_BASE_PORT);

    // 1. Start Xvfb virtual display
    const xvfbProc = spawn("Xvfb", [
      `:${displayNum}`, "-screen", "0", "1280x800x24", "-ac",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    xvfbProc.stdout?.on("data", (d: Buffer) => console.log(`[XVFB] ${d.toString().trim()}`));
    xvfbProc.stderr?.on("data", (d: Buffer) => console.error(`[XVFB] ${d.toString().trim()}`));
    xvfbProc.on("exit", (code) => console.error(`[XVFB :${displayNum}] exited with code ${code}`));
    await waitForXvfb(displayNum, 5000);

    // 2. Start x11vnc
    const x11vncProc = spawn("x11vnc", [
      "-display", `:${displayNum}`, "-rfbport", String(vncPort),
      "-nopw", "-shared", "-forever", "-quiet",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    x11vncProc.stderr?.on("data", (d: Buffer) => console.error(`[X11VNC] ${d.toString().trim()}`));
    x11vncProc.on("exit", (code) => console.error(`[X11VNC] exited with code ${code}`));
    await new Promise(r => setTimeout(r, 300));

    // 3. Start websockify (noVNC WebSocket proxy)
    const websockifyProc = spawn("websockify", [
      "--web", "/usr/share/novnc", String(wsPort), `localhost:${vncPort}`,
    ], { stdio: "ignore" });
    await new Promise(r => setTimeout(r, 300));

    // 4. Load saved storage state from S3 (service-specific key — skips Duo if still valid)
    const storageStatePath = await loadStorageStateFromS3(userId, sessionType);

    // 5. Launch Playwright browser
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
      headless: false,
      env: { ...process.env, DISPLAY: `:${displayNum}` },
      args: [
        "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
        `--display=:${displayNum}`, "--window-size=1280,800", "--window-position=0,0",
      ],
    });
    const context = await browser.newContext({
      storageState: storageStatePath,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await page.goto(targetUrl);

    // 6. Session timeout
    const timeoutHandle = setTimeout(async () => {
      console.error(`[VNC] Session ${sessionId} timed out for user ${userId}`);
      const s = activeSessions.get(sessionId);
      if (s) { s.status = "failed"; await BrowserSessionManager.closeSession(sessionId); }
    }, SESSION_TIMEOUT_MS);

    const session: BrowserSession = {
      sessionId, userId, d2lHost: targetUrl, sessionType,
      vncUrl: `https://${apiHost || process.env.API_HOST || "localhost"}/vnc/${sessionId}/vnc.html?autoconnect=true&reconnect=true&path=vnc/${sessionId}/websockify`,
      wsPort, vncPort, displayNum,
      browser, context, page,
      xvfbProc, x11vncProc, websockifyProc,
      timeoutHandle, status: "waiting", createdAt: Date.now(),
    };

    activeSessions.set(sessionId, session);
    userSessionMap.set(userId, sessionId);
    console.error(`[VNC] Started ${sessionType} session ${sessionId} for user ${userId} on display :${displayNum}, wsPort ${wsPort}`);
    return session;
  }

  /**
   * Start a D2L login session (VNC browser pointed at d2lHost).
   * Restores previous ADFS/D2L cookies from S3 — skips Duo if still valid.
   */
  static async startSession(userId: string, d2lHost: string, apiHost?: string): Promise<{ sessionId: string; vncUrl: string }> {
    const session = await BrowserSessionManager._startVNCInfra(userId, `https://${d2lHost}`, apiHost, 'd2l');
    BrowserSessionManager._watchForLogin(session.sessionId, userId, d2lHost, session.page, session.context);
    return { sessionId: session.sessionId, vncUrl: session.vncUrl };
  }

  /**
   * Start an outline.uwaterloo.ca login session.
   * Navigates to the outline site; detects login by watching for the sessionid cookie.
   * Restores previous IdP cookies from S3 — may skip Duo if ADFS session still valid.
   */
  static async startOutlineSession(userId: string, outlineHost: string, apiHost?: string): Promise<{ sessionId: string; vncUrl: string }> {
    const session = await BrowserSessionManager._startVNCInfra(userId, `https://${outlineHost}`, apiHost, 'outline');
    BrowserSessionManager._watchForOutlineLogin(session.sessionId, userId, outlineHost, session.page, session.context);
    return { sessionId: session.sessionId, vncUrl: session.vncUrl };
  }

  /**
   * Start a Crowdmark login session.
   * Navigates to app.crowdmark.com; detects login by URL (student dashboard).
   * Captures ALL cookies for the domain — avoids fragile dependency on any single cookie name.
   */
  static async startCrowdmarkSession(userId: string, apiHost?: string): Promise<{ sessionId: string; vncUrl: string }> {
    const session = await BrowserSessionManager._startVNCInfra(userId, 'https://app.crowdmark.com', apiHost, 'crowdmark');
    BrowserSessionManager._watchForCrowdmarkLogin(session.sessionId, userId, session.page, session.context);
    return { sessionId: session.sessionId, vncUrl: session.vncUrl };
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
   * Poll every 2s for a successful outline login by watching for the sessionid cookie.
   */
  private static _watchForOutlineLogin(
    sessionId: string,
    userId: string,
    outlineHost: string,
    page: Page,
    context: BrowserContext
  ) {
    const cookieDomain = outlineHost.replace(/^https?:\/\//, '');
    const interval = setInterval(async () => {
      const session = activeSessions.get(sessionId);
      if (!session || session.status !== "waiting") {
        clearInterval(interval);
        return;
      }
      try {
        const cookies = await context.cookies();
        const sessionidCookie = cookies.find(
          c => c.name === "sessionid" && c.domain.includes(cookieDomain.split('/')[0])
        );
        if (sessionidCookie) {
          clearInterval(interval);
          await BrowserSessionManager._captureAndStoreOutline(sessionId, userId, outlineHost, sessionidCookie.value, context);
        }
      } catch {
        // Page navigating — ignore
      }
    }, 2000);
  }

  /**
   * Capture the outline sessionid cookie and full storage state, persist to Supabase + S3.
   */
  private static async _captureAndStoreOutline(
    sessionId: string,
    userId: string,
    outlineHost: string,
    sessionidValue: string,
    context: BrowserContext
  ) {
    const session = activeSessions.get(sessionId);
    if (!session) return;

    try {
      console.error(`[VNC] Outline login detected for user ${userId}, capturing sessionid...`);

      // Validate the cookie works before storing
      try {
        const testUrl = `https://${outlineHost}/viewer/org/uwaterloo/`;
        const testResp = await fetch(testUrl, {
          headers: { Cookie: `sessionid=${sessionidValue}` },
          redirect: "manual",
          signal: AbortSignal.timeout(8_000),
        });
        if (testResp.status === 301 || testResp.status === 302) {
          console.error(`[VNC] Outline sessionid for user ${userId} failed validation (redirect) — still waiting`);
          session.status = "waiting";
          BrowserSessionManager._watchForOutlineLogin(sessionId, userId, outlineHost, session.page, context);
          return;
        }
      } catch (valErr: any) {
        console.error(`[VNC] Outline cookie validation error: ${valErr.message} — storing anyway`);
      }

      // Save full IdP storage state to S3 (service='outline' key, may help skip Duo next time)
      const tmpStatePath = path.join(os.tmpdir(), `outline-state-${sessionId}.json`);
      await context.storageState({ path: tmpStatePath });
      await saveStorageStateToS3(userId, tmpStatePath, undefined, 'outline');
      await fs.unlink(tmpStatePath).catch(() => {});

      // Store sessionid in Supabase under service='outline'
      const sbUrl = process.env.SUPABASE_URL;
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
      if (sbUrl && sbKey) {
        const upsertResp = await fetch(`${sbUrl}/rest/v1/user_credentials`, {
          method: "POST",
          headers: {
            "apikey": sbKey,
            "Authorization": `Bearer ${sbKey}`,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
          },
          body: JSON.stringify({
            user_id: userId,
            service: "outline",
            token: JSON.stringify({ sessionid: sessionidValue }),
            updated_at: new Date().toISOString(),
          }),
        });
        if (!upsertResp.ok) {
          const errText = await upsertResp.text();
          console.error(`[VNC] Failed to store outline credentials for user ${userId}: ${upsertResp.status} ${errText}`);
        } else {
          console.error(`[VNC] Successfully stored outline sessionid for user ${userId}`);
        }
      }

      session.status = "authenticated";
      setTimeout(() => BrowserSessionManager.closeSession(sessionId), 3000);

    } catch (err) {
      console.error(`[VNC] Error capturing outline cookies for user ${userId}:`, err);
      session.status = "failed";
      await BrowserSessionManager.closeSession(sessionId);
    }
  }

  /**
   * Poll every 2s for a successful Crowdmark login by watching for the student dashboard URL.
   * Crowdmark's session cookie name is undocumented and may change — we capture all cookies.
   */
  private static _watchForCrowdmarkLogin(
    sessionId: string,
    userId: string,
    page: Page,
    context: BrowserContext,
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
          url.includes("app.crowdmark.com/student") ||
          url.includes("app.crowdmark.com/dashboard") ||
          // Logged-in root with no login/signup/auth in path
          (url.includes("app.crowdmark.com") &&
            !url.includes("/login") &&
            !url.includes("/signup") &&
            !url.includes("/users/sign") &&
            !url.includes("/auth") &&
            !url.includes("sso") &&
            url !== "https://app.crowdmark.com/" &&
            url !== "https://app.crowdmark.com")
        );
        if (isLoggedIn) {
          clearInterval(interval);
          await BrowserSessionManager._captureAndStoreCrowdmark(sessionId, userId, context);
        }
      } catch {
        // Page navigating — ignore
      }
    }, 2000);
  }

  /**
   * Capture all app.crowdmark.com cookies as a full Cookie header string.
   * Storing all cookies avoids any dependency on a specific cookie name.
   */
  private static async _captureAndStoreCrowdmark(
    sessionId: string,
    userId: string,
    context: BrowserContext,
  ) {
    const session = activeSessions.get(sessionId);
    if (!session) return;

    try {
      console.error(`[VNC] Crowdmark login detected for user ${userId}, capturing cookies...`);

      const cookies = await context.cookies('https://app.crowdmark.com');
      console.error(`[VNC] Captured cookie names for user ${userId}: ${cookies.map(c => c.name).join(', ') || '(none)'}`);

      if (!cookies.length) {
        console.error(`[VNC] No Crowdmark cookies found for user ${userId} — waiting for login`);
        session.status = "waiting";
        BrowserSessionManager._watchForCrowdmarkLogin(sessionId, userId, session.page, context);
        return;
      }

      // Build a full Cookie header string (e.g. "name1=val1; name2=val2")
      const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

      // Validate against the real API with the same headers as production
      try {
        const testResp = await fetch('https://app.crowdmark.com/api/v2/student/assignments?fields[exam-masters][]=title', {
          headers: {
            Cookie: cookieHeader,
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          },
          signal: AbortSignal.timeout(8_000),
        });
        if (testResp.status === 401 || testResp.status === 403) {
          console.error(`[VNC] Crowdmark cookies for user ${userId} failed auth check (${testResp.status}) — waiting for fresh login`);
          session.status = "waiting";
          BrowserSessionManager._watchForCrowdmarkLogin(sessionId, userId, session.page, context);
          return;
        }
      } catch (valErr: any) {
        console.error(`[VNC] Crowdmark cookie validation error: ${valErr.message} — storing anyway`);
      }

      // Store in Supabase under service='crowdmark'
      const sbUrl = process.env.SUPABASE_URL;
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
      if (sbUrl && sbKey) {
        const upsertResp = await fetch(`${sbUrl}/rest/v1/user_credentials`, {
          method: "POST",
          headers: {
            "apikey": sbKey,
            "Authorization": `Bearer ${sbKey}`,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
          },
          body: JSON.stringify({
            user_id: userId,
            service: "crowdmark",
            token: cookieHeader,
            updated_at: new Date().toISOString(),
          }),
        });
        if (!upsertResp.ok) {
          const errText = await upsertResp.text();
          console.error(`[VNC] Failed to store Crowdmark cookies for user ${userId}: ${upsertResp.status} ${errText}`);
        } else {
          console.error(`[VNC] Successfully stored Crowdmark cookies for user ${userId} (${cookies.length} cookies)`);
        }
      }

      session.status = "authenticated";
      setTimeout(() => BrowserSessionManager.closeSession(sessionId), 3000);

    } catch (err) {
      console.error(`[VNC] Error capturing Crowdmark cookies for user ${userId}:`, err);
      session.status = "failed";
      await BrowserSessionManager.closeSession(sessionId);
    }
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
            const { deleteStorageStateFromS3 } = await import("../utils/s3Storage.js");
            await deleteStorageStateFromS3(userId);
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
              duo_required_at: null,
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

      // Mark this session as validated in the auth module's in-process cache.
      // This prevents getToken() from running validateTokenLive() on the very next
      // tool call — a transient 403 there would re-trigger markDuoRequired() and
      // overwrite the fresh token we just stored.
      markSessionValidated(userId);

      // Clear the duo_required flag since we just successfully re-authed.
      // duo_required_at is also nulled in the upsert above, but belt-and-suspenders.
      await clearDuoRequired(userId).catch((err) => {
        console.error(`[VNC] clearDuoRequired failed for user ${userId}:`, err?.message);
      });

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
