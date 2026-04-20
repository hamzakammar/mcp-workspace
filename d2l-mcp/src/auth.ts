import "dotenv/config";
import { chromium, BrowserContext } from "playwright";
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import fs from "fs/promises";
import os from "os";
import { supabase } from "./utils/supabase.js";
import { loadStorageStateFromS3, saveStorageStateToS3 } from "./utils/s3Storage.js";
import { decryptPassword } from "./utils/kms.js";
import { logCredentialAccess } from "./utils/auditLog.js";

const REMOTE_DEBUG = process.env.REMOTE_DEBUG === "true";

// Get session path for a user (or default)
function getSessionPath(userId?: string): string {
  if (userId) {
    return join(homedir(), `.d2l-session-${userId}`);
  }
  return join(homedir(), ".d2l-session");
}

// Load D2L token for a user from database
export async function getD2LToken(userId?: string): Promise<{ host: string; token: string; updated_at?: string } | null> {
  if (!userId) return null;
  try {
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    if (!sbUrl || !sbKey) return null;
    const restUrl = `${sbUrl}/rest/v1/user_credentials?user_id=eq.${userId}&service=eq.d2l&select=host,token,updated_at&limit=1`;
    const resp = await fetch(restUrl, {
      headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` },
    });
    if (!resp.ok) return null;
    const rows = await resp.json() as Array<{ host: string; token: string; updated_at: string }>;
    if (rows.length > 0 && rows[0].token) {
      return {
        host: rows[0].host || process.env.D2L_HOST || "learn.uwaterloo.ca",
        token: rows[0].token,
        updated_at: rows[0].updated_at,
      };
    }
  } catch (e) {
    console.error("[AUTH] Error loading D2L token from DB:", e);
  }
  return null;
}

// Load D2L credentials for a user from database, or fall back to env vars
export async function getD2LCredentials(userId?: string): Promise<{ host: string; username: string; password: string } | null> {
  if (userId) {
    try {
      const sbUrl = process.env.SUPABASE_URL;
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
      if (sbUrl && sbKey) {
        const restUrl = `${sbUrl}/rest/v1/user_credentials?user_id=eq.${userId}&service=eq.d2l&select=host,username,password&limit=1`;
        const resp = await fetch(restUrl, {
          headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` },
        });
        if (resp.ok) {
          const rows = await resp.json() as Array<{ host: string; username: string; password: string }>;
          if (rows.length > 0 && rows[0].username && rows[0].password) {
            await logCredentialAccess(userId, "d2l_password", "read", "getD2LCredentials");
            return {
              host: rows[0].host || process.env.D2L_HOST || "learn.uwaterloo.ca",
              username: rows[0].username,
              password: await decryptPassword(rows[0].password),
            };
          }
        }
      }
    } catch (e) {
      console.error("[AUTH] Error loading D2L credentials from DB:", e);
    }
  }

  // Fall back to environment variables
  const host = process.env.D2L_HOST || "learn.ul.ie";
  const username = process.env.D2L_USERNAME;
  const password = process.env.D2L_PASSWORD;

  if (username && password) {
    return { host, username, password };
  }

  return null;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache = { token: "", expiresAt: 0 };

function isLoginPage(url: string): boolean {
  return (
    url.includes("login") ||
    url.includes("microsoftonline") ||
    url.includes("sso") ||
    url.includes("adfs")
  );
}

// Per-user token cache
const userTokenCache: Record<string, TokenCache> = {};

// Track which users have had their token validated against D2L in this process session.
// Avoids repeated live-validation pings on every tool call; resets on PM2 restart.
const userValidatedInSession = new Set<string>();

/**
 * Validate a D2L token is still accepted by the server by hitting the lightweight
 * whoami endpoint. Times out in 5 seconds. Returns true on 200-range response,
 * false on 401/403. On network errors returns true to fail-open and avoid
 * unnecessary re-auth when D2L is temporarily unreachable.
 */
async function validateTokenLive(token: string, host: string): Promise<boolean> {
  const d2lHost = host || process.env.D2L_HOST || "learn.uwaterloo.ca";
  try {
    const headers: Record<string, string> = {};
    try {
      const parsed = JSON.parse(token);
      if (parsed.d2lSessionVal && parsed.d2lSecureSessionVal) {
        headers["Cookie"] = `d2lSessionVal=${parsed.d2lSessionVal}; d2lSecureSessionVal=${parsed.d2lSecureSessionVal}`;
      } else {
        headers["Authorization"] = `Bearer ${token}`;
      }
    } catch {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`https://${d2lHost}/d2l/api/lp/1.43/users/whoami`, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    console.error(`[AUTH] Live token validation for ${d2lHost}: HTTP ${resp.status}`);
    return resp.ok;
  } catch (e: any) {
    // Network error or timeout — fail open to avoid blocking users when D2L is slow
    console.error(`[AUTH] Live token validation failed (network/timeout): ${e.message} — assuming valid`);
    return true;
  }
}

/**
 * Mark that a user needs Duo re-authentication.
 * This is checked by the daily health job and MCP tool responses.
 */
async function markDuoRequired(userId: string): Promise<void> {
  try {
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    if (sbUrl && sbKey) {
      await fetch(`${sbUrl}/rest/v1/user_credentials?user_id=eq.${userId}&service=eq.d2l`, {
        method: "PATCH",
        headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ duo_required_at: new Date().toISOString() }),
      });
    }
    console.error(`[AUTH] Marked Duo required for user ${userId}`);
  } catch (e) {
    console.error(`[AUTH] Failed to mark Duo required for user ${userId}:`, e);
  }
}

/**
 * Clear Duo required flag after successful re-authentication.
 */
export async function clearDuoRequired(userId: string): Promise<void> {
  try {
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    if (sbUrl && sbKey) {
      await fetch(`${sbUrl}/rest/v1/user_credentials?user_id=eq.${userId}&service=eq.d2l`, {
        method: "PATCH",
        headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ duo_required_at: null, notification_sent_at: null }),
      });
    }
  } catch {}
}

/**
 * Check if a user needs Duo re-authentication.
 */
export async function isDuoRequired(userId: string): Promise<boolean> {
  try {
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    if (!sbUrl || !sbKey) return false;
    const resp = await fetch(`${sbUrl}/rest/v1/user_credentials?user_id=eq.${userId}&service=eq.d2l&select=duo_required_at&limit=1`, {
      headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` },
    });
    if (!resp.ok) return false;
    const rows = await resp.json() as Array<{ duo_required_at: string | null }>;
    return rows.length > 0 && !!rows[0].duo_required_at;
  } catch {
    return false;
  }
}

/**
 * Attempt a silent headless re-login.
 * Strategy:
 *   1. Load S3 ADFS browser state and navigate to D2L — if ADFS cookies still valid,
 *      extract fresh D2L session cookies without any MFA prompt.
 *   2. If S3 state is absent or expired (lands on login page), fall back to
 *      credential-based fill (username + password). This only works if UWaterloo
 *      ADFS accepts the credentials without Duo on a fresh browser session.
 * Returns the new token JSON string on success, null if re-login cannot complete headlessly.
 */
async function attemptSilentRelogin(userId: string): Promise<string | null> {
  console.error(`[AUTH] Attempting silent re-login for user ${userId}`);

  const creds = await getD2LCredentials(userId);
  const d2lHost = creds?.host || process.env.D2L_HOST || "learn.uwaterloo.ca";
  const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium";
  const NAV_TIMEOUT_MS = 30_000;

  // ── Path 1: Try S3 ADFS browser state (works for 30-90 days after a VNC login) ──
  const storageStatePath = await loadStorageStateFromS3(userId);
  if (storageStatePath) {
    console.error(`[AUTH] S3 browser state found for user ${userId}, trying headless S3-state refresh`);
    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        executablePath: chromiumPath,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
      });
      const context = await browser.newContext({ storageState: storageStatePath });
      const page = await context.newPage();

      await page.goto(`https://${d2lHost}/d2l/home`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(3000);

      const finalUrl = page.url();
      console.error(`[AUTH] S3-state final URL for user ${userId}: ${finalUrl}`);

      const isLoginPage =
        finalUrl.includes("login") ||
        finalUrl.includes("adfs") ||
        finalUrl.includes("microsoftonline") ||
        finalUrl.includes("sso");

      if (!isLoginPage) {
        // ADFS cookies were still valid — extract D2L session cookies
        const cookies = await context.cookies();
        const sessionVal = cookies.find(c => c.name === "d2lSessionVal" && c.domain.includes(d2lHost))?.value;
        const secureVal = cookies.find(c => c.name === "d2lSecureSessionVal" && c.domain.includes(d2lHost))?.value;

        if (sessionVal && secureVal) {
          // Persist updated ADFS state back to S3
          const tmpStatePath = join(os.tmpdir(), `silent-relogin-state-${userId}.json`);
          await context.storageState({ path: tmpStatePath });
          await saveStorageStateToS3(userId, tmpStatePath);
          await fs.unlink(tmpStatePath).catch(() => {});

          const token = JSON.stringify({ d2lSessionVal: sessionVal, d2lSecureSessionVal: secureVal });

          // Persist fresh token, clear duo_required_at
          const sbUrl = process.env.SUPABASE_URL;
          const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
          if (sbUrl && sbKey) {
            await fetch(`${sbUrl}/rest/v1/user_credentials`, {
              method: "POST",
              headers: {
                "apikey": sbKey, "Authorization": `Bearer ${sbKey}`,
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates",
              },
              body: JSON.stringify({
                user_id: userId, service: "d2l", host: d2lHost, token,
                duo_required_at: null, notification_sent_at: null,
                updated_at: new Date().toISOString(),
              }),
            });
          }

          await browser.close();
          userTokenCache[userId] = { token, expiresAt: Date.now() + 82800000 };
          console.error(`[AUTH] S3-state silent re-login succeeded for user ${userId}`);
          return token;
        }
      }

      // S3 state was expired (landed on login page) — fall through to credential fill
      console.error(`[AUTH] S3 ADFS state expired for user ${userId}, falling back to credential fill`);
      await browser.close();
    } catch (e: any) {
      console.error(`[AUTH] S3-state browser error for user ${userId}: ${e.message}`);
      if (browser) await browser.close().catch(() => {});
    }
  } else {
    console.error(`[AUTH] No S3 browser state for user ${userId}, trying credential fill`);
  }

  // ── Path 2: Credential-based headless login (requires no Duo on fresh session) ──
  if (!creds?.username || !creds?.password) {
    console.error(`[AUTH] No stored credentials for user ${userId}, cannot silent re-login`);
    return null;
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: chromiumPath,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    // Restore S3 storage state so the Duo "remember this device" cookie is present,
    // allowing credential fill to bypass the Duo challenge (same as VNC does).
    const context = await browser.newContext(
      storageStatePath ? { storageState: storageStatePath } : {}
    );
    const page = await context.newPage();

    await page.goto(`https://${d2lHost}/d2l/home`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    console.error(`[AUTH] Credential login final URL for user ${userId}: ${finalUrl}`);

    if (finalUrl.includes("duo") || finalUrl.includes("duosecurity")) {
      console.error(`[AUTH] Silent re-login hit Duo wall for user ${userId}`);
      await browser.close();
      return null;
    }

    if (
      finalUrl.includes("adfs") ||
      finalUrl.includes("login") ||
      finalUrl.includes("saml") ||
      finalUrl.includes("microsoftonline") ||
      finalUrl.includes("sso")
    ) {
      console.error(`[AUTH] Silent re-login on auth page, attempting credential fill for user ${userId}`);

      // Record pre-login D2L cookie values so we can verify login actually succeeded
      const preCookies = await context.cookies();
      const preSessionVal = preCookies.find(c => c.name === "d2lSessionVal")?.value;
      const preSecureVal = preCookies.find(c => c.name === "d2lSecureSessionVal")?.value;

      // UWaterloo ADFS requires full UPN format (user@uwaterloo.ca)
      const loginUsername = creds.username.includes('@') ? creds.username : `${creds.username}@uwaterloo.ca`;
      console.error(`[AUTH] Using login username: ${loginUsername} (stored: ${creds.username})`);
      await page.fill('input[type="text"], input[name="UserName"], input[name="username"]', loginUsername).catch(() => {});

      // If password field is already visible (single-page ADFS form), skip the "Next" step.
      const passwordVisible = await page.locator('input[type="password"]').isVisible({ timeout: 500 }).catch(() => false);
      if (!passwordVisible) {
        // Multi-step form: use only specific Next/Continue selectors (not generic submit,
        // which would submit the form prematurely with only the username filled).
        const nextSelectors = [
          'input[value*="Next" i]',
          'button:has-text("Next")',
          'button:has-text("Continue")',
        ];
        let clicked = false;
        for (const sel of nextSelectors) {
          try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 1000 })) {
              await btn.click();
              clicked = true;
              break;
            }
          } catch { continue; }
        }
        if (!clicked) {
          await page.locator('input[name="UserName"], input[type="text"]').first().press("Enter").catch(() => {
            page.keyboard.press("Enter");
          });
        }
        await page.waitForSelector('input[type="password"]', { timeout: 5000 }).catch(() => {});
      }

      await page.fill('input[type="password"], input[name="Password"], input[name="password"]', creds.password).catch(() => {});

      const submitSelectors = [
        'input[type="submit"]', 'button[type="submit"]',
        'button:has-text("Sign in")', 'button:has-text("Log in")', '#submitButton',
      ];
      let submitted = false;
      for (const sel of submitSelectors) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 1000 })) {
            await btn.click();
            submitted = true;
            break;
          }
        } catch { continue; }
      }
      if (!submitted) {
        await page.keyboard.press("Enter");
      }

      // Wait up to 35s for navigation away from ADFS.
      // UWaterloo embeds Duo MFA within the ADFS flow — the browser stays at adfs.*
      // while Duo processes the "remember this device" cookie (can take 20-30s).
      try {
        await page.waitForURL(
          url => !url.hostname.includes("adfs.uwaterloo.ca"),
          { timeout: 35000 }
        );
        await page.waitForTimeout(2000);
      } catch {
        // Still on ADFS after 35s — fall through, check cookies below
      }

      const postLoginUrl = page.url();
      console.error(`[AUTH] Post-credential URL for user ${userId}: ${postLoginUrl}`);

      // Verify D2L cookies actually changed — if unchanged, login didn't complete
      const postCookies = await context.cookies();
      const sessionVal = postCookies.find(c => c.name === "d2lSessionVal")?.value;
      const secureVal = postCookies.find(c => c.name === "d2lSecureSessionVal")?.value;

      if (!sessionVal || !secureVal || (sessionVal === preSessionVal && secureVal === preSecureVal)) {
        const pageTitle = await page.title().catch(() => "unknown");
        console.error(`[AUTH] Silent re-login: cookies unchanged for user ${userId} — page="${pageTitle}"`);
        await browser.close();
        return null;
      }

      const token = JSON.stringify({ d2lSessionVal: sessionVal, d2lSecureSessionVal: secureVal });

      // Save browser state to S3 for future refreshes
      try {
        const tmpStatePath = join(os.tmpdir(), `silent-relogin-state-${userId}.json`);
        await context.storageState({ path: tmpStatePath });
        await saveStorageStateToS3(userId, tmpStatePath);
        await fs.unlink(tmpStatePath).catch(() => {});
        console.error(`[AUTH] Saved browser storage state to S3 for user ${userId}`);
      } catch (s3Err: any) {
        console.error(`[AUTH] Failed to save browser state to S3 for user ${userId}: ${s3Err?.message}`);
      }

      const sbUrl = process.env.SUPABASE_URL;
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
      if (sbUrl && sbKey) {
        await fetch(`${sbUrl}/rest/v1/user_credentials`, {
          method: "POST",
          headers: {
            "apikey": sbKey, "Authorization": `Bearer ${sbKey}`,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
          },
          body: JSON.stringify({
            user_id: userId, service: "d2l", host: d2lHost, token,
            duo_required_at: null, notification_sent_at: null,
            updated_at: new Date().toISOString(),
          }),
        });
      }

      await browser.close();
      userTokenCache[userId] = { token, expiresAt: Date.now() + 82800000 };
      console.error(`[AUTH] Credential silent re-login succeeded for user ${userId}`);
      return token;
    }

    // Landed directly on D2L — extract existing session cookies
    const cookies = await context.cookies();
    const sessionVal = cookies.find(c => c.name === "d2lSessionVal")?.value;
    const secureVal = cookies.find(c => c.name === "d2lSecureSessionVal")?.value;

    if (!sessionVal || !secureVal) {
      const pageTitle = await page.title().catch(() => "unknown");
      console.error(`[AUTH] Silent re-login: no D2L cookies for user ${userId} — page="${pageTitle}" url=${page.url()}`);
      await browser.close();
      return null;
    }

    const token = JSON.stringify({ d2lSessionVal: sessionVal, d2lSecureSessionVal: secureVal });

    // Save browser state to S3 for future refreshes
    try {
      const tmpStatePath = join(os.tmpdir(), `silent-relogin-state-${userId}.json`);
      await context.storageState({ path: tmpStatePath });
      await saveStorageStateToS3(userId, tmpStatePath);
      await fs.unlink(tmpStatePath).catch(() => {});
      console.error(`[AUTH] Saved browser storage state to S3 for user ${userId}`);
    } catch (s3Err: any) {
      console.error(`[AUTH] Failed to save browser state to S3 for user ${userId}: ${s3Err?.message}`);
    }

    // Persist new token via REST API
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    if (sbUrl && sbKey) {
      await fetch(`${sbUrl}/rest/v1/user_credentials`, {
        method: "POST",
        headers: {
          "apikey": sbKey, "Authorization": `Bearer ${sbKey}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates",
        },
        body: JSON.stringify({
          user_id: userId, service: "d2l", host: d2lHost, token,
          duo_required_at: null, notification_sent_at: null,
          updated_at: new Date().toISOString(),
        }),
      });
    }

    await browser.close();
    userTokenCache[userId] = { token, expiresAt: Date.now() + 82800000 };
    console.error(`[AUTH] Credential silent re-login succeeded for user ${userId}`);
    return token;

  } catch (e: any) {
    console.error(`[AUTH] Silent re-login error for user ${userId}: ${e.message}`);
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

export async function getToken(userId?: string): Promise<string> {
  const authStartTime = Date.now();
  const cacheKey = userId || "default";
  const isProduction = process.env.NODE_ENV === "production";

  // If userId is provided, check for stored token first (from WebView login)
  if (userId) {
    const userToken = await getD2LToken(userId);
    if (userToken && userToken.token) {
      // Check if token is already aged (older than 14 hours — scheduler refreshes at 12h)
      const tokenAge = Date.now() - (new Date(userToken.updated_at || 0).getTime());
      const maxAge = 14 * 60 * 60 * 1000; // 14 hours
      
      if (tokenAge > maxAge) {
        console.error(`[AUTH] Stored token for user ${userId} is too old (${Math.round(tokenAge / 3600000)}h), attempting silent re-login`);
        // Try headless re-login with stored credentials before giving up
        const refreshed = await attemptSilentRelogin(userId);
        if (refreshed) {
          userValidatedInSession.add(userId);
          return refreshed;
        }
        // If silent re-login fails (Duo wall), mark duo_required and throw
        await markDuoRequired(userId);
        throw new Error("REAUTH_REQUIRED");
      } else {
        console.error(`[AUTH] Using stored token for user ${userId} (age: ${Math.round(tokenAge / 3600000)}h)`);
        // On first use after a PM2 restart / server boot, validate the token is still
        // accepted by D2L before trusting it.  This catches tokens that expired while
        // the server was down and avoids a confusing 403 on the first real API call.
        if (!userValidatedInSession.has(userId)) {
          console.error(`[AUTH] First use in this process session for user ${userId} — running live token validation`);
          const isLive = await validateTokenLive(userToken.token, userToken.host);
          if (!isLive) {
            console.error(`[AUTH] Token for user ${userId} rejected by D2L — attempting silent re-login`);
            const refreshed = await attemptSilentRelogin(userId);
            if (refreshed) {
              userValidatedInSession.add(userId);
              clearDuoRequired(userId).catch(() => {});
              return refreshed;
            }
            await markDuoRequired(userId);
            throw new Error("REAUTH_REQUIRED");
          }
          userValidatedInSession.add(userId);
        }
        // Clear duo_required flag if it was set — token is valid now
        clearDuoRequired(userId).catch(() => {});
        userTokenCache[cacheKey] = {
          token: userToken.token,
          expiresAt: Date.now() + 82800000,
        };
        return userToken.token;
      }
    }

    // No token at all — try silent re-login with stored credentials
    console.error(`[AUTH] No token for user ${userId}, attempting silent re-login`);
    const refreshed = await attemptSilentRelogin(userId);
    if (refreshed) return refreshed;

    // Silent re-login failed — Duo required
    await markDuoRequired(userId);
    throw new Error("REAUTH_REQUIRED");
  } else {
    // No userId - use env token if available (legacy behavior)
    const envToken = process.env.D2L_TOKEN;
    if (envToken) {
      console.error("[AUTH] Using D2L_TOKEN from environment variable (no userId)");
      userTokenCache[cacheKey] = {
        token: envToken,
        expiresAt: Date.now() + 82800000, // 23 hours
      };
      return envToken;
    }
  }

  // Return cached token if still valid (with 1 hour buffer for safety)
  // Also check if token is already aged beyond reasonable use
  const cachedToken = userTokenCache[cacheKey];
  if (cachedToken?.token) {
    const timeUntilExpiry = cachedToken.expiresAt - Date.now();
    const isExpired = timeUntilExpiry < 3600000; // Less than 1 hour left
    
    if (!isExpired) {
      const cacheTime = Date.now() - authStartTime;
      console.error(
        `[AUTH] Token cache hit for user ${userId || 'default'} (${cacheTime}ms, expires in ${Math.round(
          timeUntilExpiry / 1000
        )}s)`
      );
      return cachedToken.token;
    } else {
      console.error(
        `[AUTH] Cached token for user ${userId || 'default'} is expired or too close to expiry (${Math.round(
          timeUntilExpiry / 1000
        )}s), refreshing`
      );
      // Clear expired cache
      delete userTokenCache[cacheKey];
    }
  }

  console.error(`[AUTH] Token cache miss - refreshing token for user ${userId || 'default'}`);
  const sessionPath = getSessionPath(userId);
  const hasExistingSession = existsSync(sessionPath);
  console.error(
    `[AUTH] Existing session file: ${hasExistingSession ? "yes" : "no"}`
  );

  // Load credentials
  const credentials = await getD2LCredentials(userId);
  const D2L_HOST = credentials?.host || process.env.D2L_HOST || "learn.ul.ie";
  const D2L_USERNAME = credentials?.username || process.env.D2L_USERNAME;
  const D2L_PASSWORD = credentials?.password || process.env.D2L_PASSWORD;
  const HOME_URL = `https://${D2L_HOST}/d2l/home`;

  // Configure browser args for remote debugging if enabled
  const browserArgs: string[] = [];
  if (REMOTE_DEBUG) {
    browserArgs.push(
      '--remote-debugging-port=9222',
      '--no-sandbox',
      '--disable-setuid-sandbox'
    );
    console.error('[AUTH] Remote debugging enabled on port 9222');
    console.error('[AUTH] Connect via: chrome://inspect after setting up SSH tunnel');
    console.error('[AUTH] SSH tunnel: ssh -L 9222:localhost:9222 ec2-user@your-ip');
  }

  // Always try headless first if session exists - only show browser if login needed
  const browserStartTime = Date.now();
  // Use the isProduction variable already declared at the top of getToken function
  const isProductionEnv = process.env.NODE_ENV === "production" || !process.env.DISPLAY;
  
  // In Docker/production/AWS, ALWAYS use headless mode
  const headlessMode = isProductionEnv || (hasExistingSession && !REMOTE_DEBUG);
  
  // In production, ensure we never launch a headed browser
  if (isProductionEnv && !headlessMode) {
    console.error("[AUTH] Production mode: Forcing headless mode");
  }
  
  // Add required args for headless mode in Docker/Alpine
  const dockerArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=TranslateUI',
    '--disable-ipc-flooding-protection',
    '--single-process', // Required for some Docker environments
  ];
  
  const allArgs = [...dockerArgs, ...browserArgs];
  
  // Try to use Alpine's chromium if available, otherwise use Playwright's
  const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || 
                       (isProduction ? '/usr/bin/chromium' : undefined);
  
  let context;
  try {
    context = await chromium.launchPersistentContext(sessionPath, {
      headless: headlessMode, // true for headless, false for headed
      viewport: { width: 1280, height: 720 },
      args: allArgs.length > 0 ? allArgs : undefined,
      executablePath: chromiumPath,
    } as any); // Type assertion for headless: 'shell' support
  } catch (launchError: any) {
    // If launch fails, try without explicit executable path (use Playwright's bundled)
    console.error(`[AUTH] First launch attempt failed: ${launchError.message}`);
    console.error(`[AUTH] Retrying without explicit executable path...`);
    context = await chromium.launchPersistentContext(sessionPath, {
      headless: headlessMode,
      viewport: { width: 1280, height: 720 },
      args: allArgs.length > 0 ? allArgs : undefined,
    } as any);
  }
  const browserTime = Date.now() - browserStartTime;
  console.error(
    `[AUTH] Browser launched (headless: ${isProductionEnv || hasExistingSession}, ${browserTime}ms)`
  );

  try {
    const captureStartTime = Date.now();
    const result = await captureToken(context, hasExistingSession, HOME_URL, D2L_USERNAME, D2L_PASSWORD, userId);
    const captureTime = Date.now() - captureStartTime;
    console.error(`[AUTH] Token captured (${captureTime}ms)`);

    // If we need to login and were running headless, restart with headed browser (only in non-production)
    if (result.needsLogin && hasExistingSession && !isProductionEnv) {
      await context.close();
      console.error("[AUTH] Session expired, opening browser for login...");
      const retryBrowserStartTime = Date.now();
      context = await chromium.launchPersistentContext(sessionPath, {
        headless: false,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
        viewport: { width: 1280, height: 720 },
        args: browserArgs.length > 0 ? browserArgs : undefined,
      });
      const retryBrowserTime = Date.now() - retryBrowserStartTime;
      console.error(
        `[AUTH] Browser relaunched (headed, ${retryBrowserTime}ms)`
      );

      const retryCaptureStartTime = Date.now();
      const retryResult = await captureToken(context, false, HOME_URL, D2L_USERNAME, D2L_PASSWORD, userId);
      const retryCaptureTime = Date.now() - retryCaptureStartTime;
      console.error(`[AUTH] Token captured on retry (${retryCaptureTime}ms)`);

      userTokenCache[cacheKey] = {
        token: retryResult.token,
        expiresAt: Date.now() + 82800000, // 23 hours
      };
      const totalTime = Date.now() - authStartTime;
      console.error(`[AUTH] Token refresh completed (${totalTime}ms)`);
      return retryResult.token;
    } else if (result.needsLogin && isProductionEnv) {
      // In production, we cannot handle login - throw REAUTH_REQUIRED
      await context.close();
      throw new Error("REAUTH_REQUIRED");
    }

    userTokenCache[cacheKey] = {
      token: result.token,
      expiresAt: Date.now() + 82800000, // 23 hours
    };
    const totalTime = Date.now() - authStartTime;
    console.error(`[AUTH] Token refresh completed (${totalTime}ms)`);
    return result.token;
  } finally {
    const closeStartTime = Date.now();
    await context.close();
    const closeTime = Date.now() - closeStartTime;
    console.error(`[AUTH] Browser context closed (${closeTime}ms)`);
  }
}

async function captureToken(
  context: BrowserContext,
  quickCheck: boolean,
  homeUrl: string,
  username?: string | null,
  password?: string | null,
  userId?: string
): Promise<{ token: string; needsLogin: boolean }> {
  const captureStartTime = Date.now();
  console.error(`[AUTH] Starting token capture (quickCheck: ${quickCheck})`);

  // First, try to get cookies from database (prioritize stored cookies)
  if (userId) {
    try {
      const storedToken = await getD2LToken(userId);
      if (storedToken && storedToken.token) {
        // Check if it's a cookie string (contains d2lSessionVal or d2lSecureSessionVal)
        if (storedToken.token.includes('d2lSessionVal') || storedToken.token.includes('d2lSecureSessionVal')) {
          const tokenAge = Date.now() - (new Date(storedToken.updated_at || 0).getTime());
          const maxAge = 23 * 60 * 60 * 1000; // 23 hours
          
          if (tokenAge < maxAge) {
            console.error(`[AUTH] Using stored cookies from database (age: ${Math.round(tokenAge / 3600000)}h)`);
            return { token: storedToken.token, needsLogin: false };
          } else {
            console.error(`[AUTH] Stored cookies are too old (${Math.round(tokenAge / 3600000)}h), will capture new ones`);
          }
        }
      }
    } catch (e) {
      console.error(`[AUTH] Error checking stored cookies: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const page = await context.newPage();
  let capturedToken = "";
  
  // Helper function to extract cookies from browser context
  // Prioritize d2lSessionVal and d2lSecureSessionVal
  const extractCookiesFromContext = async (): Promise<string | null> => {
    try {
      const cookies = await context.cookies();
      // Prioritize the two essential cookies
      const essentialCookies = cookies.filter(c => 
        c.name === 'd2lSessionVal' || 
        c.name === 'd2lSecureSessionVal'
      );
      
      // Also include other D2L session cookies if available
      const otherD2lCookies = cookies.filter(c => 
        (c.name.includes('d2lSession') || 
         c.name.includes('d2lSecure') ||
         c.name.includes('d2lUser') ||
         c.name.includes('d2lAuth')) &&
        c.name !== 'd2lSessionVal' &&
        c.name !== 'd2lSecureSessionVal'
      );
      
      // Combine essential cookies first, then others
      const allD2lCookies = [...essentialCookies, ...otherD2lCookies];
      
      if (allD2lCookies.length > 0) {
        const cookieString = allD2lCookies.map(c => `${c.name}=${c.value}`).join('; ');
        console.error(`[AUTH] Extracted ${allD2lCookies.length} D2L cookies from context: ${allD2lCookies.map(c => c.name).join(', ')}`);
        
        // Ensure we have at least one of the essential cookies
        if (essentialCookies.length > 0) {
          return cookieString;
        } else {
          console.error(`[AUTH] Warning: No essential cookies (d2lSessionVal/d2lSecureSessionVal) found, but found other cookies`);
          return cookieString; // Still return it, but log warning
        }
      }
    } catch (e) {
      console.error(`[AUTH] Failed to extract cookies from context: ${e instanceof Error ? e.message : String(e)}`);
    }
    return null;
  };

  // Listen for requests to capture Authorization header or cookies from any D2L API call
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/d2l/api/")) {
      // Try to capture Bearer token first
      const auth = request.headers()["authorization"];
      if (auth?.startsWith("Bearer ")) {
        capturedToken = auth.slice(7);
        const captureTime = Date.now() - captureStartTime;
        console.error(
          `[AUTH] Token captured from API request Authorization header to ${url} (${captureTime}ms)`
        );
        return;
      }
      
      // Fallback: Try to capture cookies (D2L might use session cookies instead of Bearer token)
      const cookies = request.headers()["cookie"];
      if (cookies && (cookies.includes("d2lSessionVal") || cookies.includes("d2lSecureSessionVal"))) {
        capturedToken = cookies;
        const captureTime = Date.now() - captureStartTime;
        console.error(
          `[AUTH] Token captured from API request cookies to ${url} (${captureTime}ms)`
        );
      }
    }
  });
  
  // Also listen for responses to capture cookies from Set-Cookie headers
  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes("/d2l/api/") || url.includes("/d2l/home")) {
      const setCookieHeaders = response.headers()["set-cookie"];
      if (setCookieHeaders) {
        const cookies = Array.isArray(setCookieHeaders) ? setCookieHeaders.join("; ") : setCookieHeaders;
        if (cookies.includes("d2lSessionVal") || cookies.includes("d2lSecureSessionVal")) {
          if (!capturedToken || !capturedToken.includes("d2lSessionVal")) {
            // Extract relevant cookies
            const cookieParts = cookies.split(";").filter(c => 
              c.includes("d2lSessionVal") || 
              c.includes("d2lSecureSessionVal") || 
              c.includes("d2lSessionId") ||
              c.includes("d2lUser")
            );
            if (cookieParts.length > 0) {
              capturedToken = cookieParts.join("; ");
              const captureTime = Date.now() - captureStartTime;
              console.error(
                `[AUTH] Token captured from response Set-Cookie headers from ${url} (${captureTime}ms)`
              );
            }
          }
        }
      }
    }
  });

  // Go to home page
  const navigateStartTime = Date.now();
  console.error(`[AUTH] Navigating to ${homeUrl}`);
  await page.goto(homeUrl, { waitUntil: "networkidle" });
  const navigateTime = Date.now() - navigateStartTime;
  console.error(`[AUTH] Navigation completed (${navigateTime}ms)`);

  // Check if we're on login page
  let currentUrl = page.url();
  const isOnLoginPage = isLoginPage(currentUrl);
  console.error(
    `[AUTH] Current URL: ${currentUrl}, Is login page: ${isOnLoginPage}`
  );

  if (isOnLoginPage) {
    console.error(`[AUTH] Login required`);
    // If username and password are provided, use them for login
    if (username && password) {
      console.error(`[AUTH] Attempting automated login with credentials`);
      console.error(`[AUTH] Username configured: ${username ? 'yes' : 'no'}`);
      console.error(`[AUTH] Password configured: ${password ? 'yes (hidden)' : 'no'}`);
      try {
        // Try to find and fill username field (common selectors)
        const usernameSelectors = [
          "input#userNameInput", // Microsoft ADFS
          'input[name="UserName"]', // Microsoft ADFS
          'input[type="email"]',
          'input[placeholder*="username" i]',
          'input[placeholder*="user" i]',
          'input[placeholder*="MyCarletonOne" i]',
          'input[name="userName"]',
          'input[name="username"]',
          'input[name="user"]',
          'input[type="text"][id*="user"]',
          'input[type="text"][id*="User"]',
          "input#userName",
          "input#username",
        ];

        const passwordSelectors = [
          "input#passwordInput", // Microsoft ADFS
          'input[name="Password"]', // Microsoft ADFS
          'input[type="password"][placeholder*="password" i]',
          'input[type="password"][placeholder*="Password" i]',
          'input[name="password"]',
          'input[name="passWord"]',
          'input[type="password"]',
          "input#password",
          "input#passWord",
        ];

        let usernameField = null;
        let passwordField = null;

        // Try to find username field
        console.error(`[AUTH] Searching for username field...`);
        for (const selector of usernameSelectors) {
          try {
            const field = page.locator(selector);
            if (await field.isVisible({ timeout: 2000 })) {
              usernameField = field;
              console.error(`[AUTH] Found username field with selector: ${selector}`);
              break;
            }
          } catch {
            continue;
          }
        }

        if (!usernameField) {
          console.error(`[AUTH] Could not find username field`);
          throw new Error("Could not find username field");
        }

        // Fill username first - password field might appear after
        console.error(`[AUTH] Filling username field...`);
        await usernameField.fill(username);
        
        // Look for a "Next" or "Continue" button (common in multi-step forms)
        console.error(`[AUTH] Looking for Next/Continue button...`);
        const nextButtonSelectors = [
          'input[type="submit"]',
          'button[type="submit"]',
          'input[value*="Next" i]',
          'button:has-text("Next")',
          'button:has-text("Continue")',
          'input[value*="Continue" i]',
          'button:has-text("Submit")',
          '#submitButton',
        ];
        
        let nextButtonClicked = false;
        for (const selector of nextButtonSelectors) {
          try {
            const nextButton = page.locator(selector).first();
            if (await nextButton.isVisible({ timeout: 1000 })) {
              console.error(`[AUTH] Found Next button with selector: ${selector}, clicking...`);
              await nextButton.click();
              nextButtonClicked = true;
              await page.waitForTimeout(2000); // Wait for password page to load
              break;
            }
          } catch {
            continue;
          }
        }
        
        if (!nextButtonClicked) {
          console.error(`[AUTH] No Next button found, trying Enter key...`);
          await usernameField.press("Enter");
          await page.waitForTimeout(2000); // Wait for password page to load
        }

        // Try to find password field
        console.error(`[AUTH] Searching for password field...`);
        for (const selector of passwordSelectors) {
          try {
            const field = page.locator(selector);
            if (await field.isVisible({ timeout: 3000 })) {
              passwordField = field;
              console.error(`[AUTH] Found password field with selector: ${selector}`);
              break;
            }
          } catch {
            continue;
          }
        }

        if (!passwordField) {
          console.error(`[AUTH] Could not find password field after filling username`);
          throw new Error("Could not find password field");
        }

        // Fill password
        console.error(`[AUTH] Filling password field...`);
        await passwordField.fill(password);
        console.error(`[AUTH] Credentials filled, looking for submit button...`);

          // Try to find and click submit button
          const submitSelectors = [
            'input[type="submit"]',
            'button[type="submit"]',
            'button:has-text("Log in")',
            'button:has-text("Login")',
            'button:has-text("Sign in")',
            'button:has-text("Sign In")',
            'input[value*="Sign in" i]',
            'input[value*="Log in" i]',
            "form button",
            'form input[type="submit"]',
          ];

          let submitted = false;
          for (const selector of submitSelectors) {
            try {
              const submitButton = page.locator(selector).first();
              if (await submitButton.isVisible({ timeout: 1000 })) {
                console.error(`[AUTH] Found submit button with selector: ${selector}`);
                await submitButton.click();
                submitted = true;
                break;
              }
            } catch {
              continue;
            }
          }

          // If no submit button found, try pressing Enter or submitting form
          if (!submitted) {
            console.error(`[AUTH] No submit button found, trying form submission...`);
            try {
              // Try multiple submission methods
              await page.evaluate(() => {
                const form = document.querySelector('form');
                if (form) {
                  // Try triggering submit event first (for JS handlers)
                  const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
                  if (form.dispatchEvent(submitEvent)) {
                    form.submit();
                  }
                  return;
                }
              });
              await page.waitForTimeout(2000);
            } catch (e) {
              // Fallback to pressing Enter on password field
              console.error(`[AUTH] Form submit failed, pressing Enter...`);
              try {
                await passwordField.press("Enter");
                await page.waitForTimeout(2000);
              } catch (enterError) {
                console.error(`[AUTH] Enter key press also failed: ${enterError}`);
              }
            }
          }

          // Wait for navigation away from login page
          // Reduced timeout to prevent overall process from exceeding ALB timeout
          const loginWaitStartTime = Date.now();
          console.error(`[AUTH] Waiting for login to complete...`);
          await page.waitForURL((url) => !isLoginPage(url.toString()), {
            timeout: quickCheck ? 20000 : 30000, // Reduced from 60000 to 30000
          });
          await page.waitForLoadState("networkidle");
          const loginWaitTime = Date.now() - loginWaitStartTime;
          console.error(`[AUTH] Login completed (${loginWaitTime}ms)`);
          
          // Extract cookies directly from browser context after login
          const extractedCookies = await extractCookiesFromContext();
          if (extractedCookies) {
            capturedToken = extractedCookies;
            console.error(`[AUTH] Token captured from browser context cookies immediately after login`);
          } else {
            // Also try extracting from page's document.cookie
            try {
              const pageCookies = await page.evaluate(() => document.cookie);
              if (pageCookies && (pageCookies.includes('d2lSessionVal') || pageCookies.includes('d2lSecureSessionVal'))) {
                capturedToken = pageCookies;
                console.error(`[AUTH] Token captured from document.cookie`);
              }
            } catch (e) {
              console.error(`[AUTH] Failed to read document.cookie: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          
          // If we still don't have a token, wait a bit for cookies to be set, then try again
          if (!capturedToken) {
            console.error(`[AUTH] No token captured yet, waiting for cookies to be set...`);
            await page.waitForTimeout(2000);
            const retryCookies = await extractCookiesFromContext();
            if (retryCookies) {
              capturedToken = retryCookies;
              console.error(`[AUTH] Token captured from browser context after wait`);
            }
          }
          
          // If we still don't have a token, trigger an API call to force cookie usage
          if (!capturedToken) {
            try {
              const apiUrl = homeUrl.replace('/d2l/home', '/d2l/api/lp/1.43/enrollments/myenrollments/');
              console.error(`[AUTH] No token yet, triggering API call to capture token: ${apiUrl}`);
              await page.goto(apiUrl, { waitUntil: "networkidle", timeout: 15000 });
              await page.waitForTimeout(2000); // Give time for request to complete
              
              // Try extracting cookies again after API call
              const finalCookies = await extractCookiesFromContext();
              if (finalCookies) {
                capturedToken = finalCookies;
                console.error(`[AUTH] Token captured from browser context after API call`);
              }
            } catch (e) {
              console.error(`[AUTH] Failed to trigger API call: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
      } catch (error) {
        // Fall back to SSO button click if form login fails
        console.error(`[AUTH] Form login failed: ${error instanceof Error ? error.message : String(error)}`);
        console.error("[AUTH] Trying SSO button as fallback...");
        try {
          const ssoButton = page.locator(
            'button.d2l-button-sso-1, button:has-text("Student & Staff Login")'
          );
          if (await ssoButton.isVisible({ timeout: 2000 })) {
            await ssoButton.click();
            await page.waitForURL((url) => !isLoginPage(url.toString()), {
              timeout: quickCheck ? 15000 : 30000, // Reduced from 60000 to 30000
            });
            await page.waitForLoadState("networkidle");
          }
        } catch {
          if (quickCheck) {
            await page.close();
            return { token: "", needsLogin: true };
          }
        }
      }
    } else {
      // No credentials provided, try SSO button
      try {
        const ssoButton = page.locator(
          'button.d2l-button-sso-1, button:has-text("Student & Staff Login")'
        );
        if (await ssoButton.isVisible({ timeout: 2000 })) {
          await ssoButton.click();
          // Wait for SSO redirect and completion
          await page.waitForURL((url) => !isLoginPage(url.toString()), {
            timeout: quickCheck ? 15000 : 60000,
          });
          await page.waitForLoadState("networkidle");
        }
      } catch {
        // SSO auto-login failed (needs user interaction)
        if (quickCheck) {
          await page.close();
          return { token: "", needsLogin: true };
        }
      }
    }
  }

  // Wait for token capture
  // Reduced max wait to prevent 504 Gateway Timeout (ALB timeout is typically 60s)
  const maxWait = quickCheck ? 10000 : 45000; // Reduced from 120000 to 45000 (45s)
  const waitStartTime = Date.now();
  console.error(`[AUTH] Waiting for token capture (max wait: ${maxWait}ms)`);

  while (Date.now() - waitStartTime < maxWait) {
    try {
      currentUrl = page.url();
    } catch (e) {
      // Page might have navigated or closed, check if we have token
      console.error(`[AUTH] Failed to get page URL (page may have navigated): ${e instanceof Error ? e.message : String(e)}`);
      if (capturedToken) {
        const waitTime = Date.now() - waitStartTime;
        console.error(`[AUTH] Token captured before page navigation (${waitTime}ms)`);
        break;
      }
      // If no token and page is gone, wait a bit and check again
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }

    if (!isLoginPage(currentUrl)) {
      // We're logged in, wait for API calls
      if (!capturedToken) {
        console.error(
          `[AUTH] Token not captured yet, waiting and scrolling...`
        );
        try {
          await page.waitForTimeout(2000);
          // Try scrolling to trigger more API calls (wrap in try-catch in case page navigates)
          try {
            await page.evaluate(() => window.scrollBy(0, 100));
          } catch (e) {
            // Page might have navigated, that's okay - token might have been captured
            console.error(`[AUTH] Scroll failed (page may have navigated): ${e instanceof Error ? e.message : String(e)}`);
          }
          await page.waitForTimeout(1000);
        } catch (e) {
          // Page might have navigated or closed, check if we have token
          console.error(`[AUTH] Wait failed (page may have navigated): ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (capturedToken) {
        const waitTime = Date.now() - waitStartTime;
        console.error(`[AUTH] Token captured after waiting (${waitTime}ms)`);
        break;
      }
    } else if (!quickCheck) {
      // Wait for user to login
      try {
        await page.waitForTimeout(2000);
      } catch (e) {
        // Page might have navigated, that's okay
        console.error(`[AUTH] Wait failed during login wait: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      break;
    }
  }

  const closePageStartTime = Date.now();
  await page.close();
  const closePageTime = Date.now() - closePageStartTime;
  console.error(`[AUTH] Page closed (${closePageTime}ms)`);

  if (!capturedToken) {
    const totalTime = Date.now() - captureStartTime;
    if (quickCheck) {
      console.error(
        `[AUTH] Token capture failed (quickCheck mode, ${totalTime}ms) - needs login`
      );
      return { token: "", needsLogin: true };
    }
    console.error(`[AUTH] Token capture failed (${totalTime}ms)`);
    throw new Error(
      "Failed to capture authentication token. Please try again."
    );
  }

  const totalTime = Date.now() - captureStartTime;
  console.error(`[AUTH] Token capture successful (${totalTime}ms)`);
  return { token: capturedToken, needsLogin: false };
}

export async function refreshTokenIfNeeded(userId?: string): Promise<string> {
  return getToken(userId);
}

/**
 * Force an immediate headless re-login, bypassing the age check.
 * Called when a D2L API request returns 403 (server-side session died before the
 * scheduled refresh had a chance to run).
 * Returns the new token on success, null if re-login cannot complete headlessly.
 */
export async function forceRefreshToken(userId: string): Promise<string | null> {
  clearTokenCache(userId);
  userValidatedInSession.delete(userId);
  console.error(`[AUTH] Force-refreshing token for user ${userId} (session died mid-use)`);
  const token = await attemptSilentRelogin(userId);
  if (!token) {
    await markDuoRequired(userId);
  }
  return token;
}

export function clearTokenCache(userId?: string): void {
  const cacheKey = userId || "default";
  if (userId) {
    delete userTokenCache[cacheKey];
    userValidatedInSession.delete(userId);
  } else {
    userTokenCache[cacheKey] = { token: "", expiresAt: 0 };
  }
}

/** Reset the per-session validation flag for a user (e.g. after forced token refresh). */
export function clearSessionValidation(userId: string): void {
  userValidatedInSession.delete(userId);
}

/**
 * Mark a user's session as validated for this process session.
 * Called after VNC or headless re-login successfully captures and validates
 * fresh D2L cookies. Prevents getToken() from running a redundant
 * validateTokenLive() on the very next tool call (which could fail transiently
 * and trigger another markDuoRequired + REAUTH_REQUIRED cycle).
 */
export function markSessionValidated(userId: string): void {
  userValidatedInSession.add(userId);
  console.error(`[AUTH] Session marked as validated for user ${userId} (post-VNC)`);
}

export function getTokenExpiry(userId?: string): number {
  const cacheKey = userId || "default";
  return userTokenCache[cacheKey]?.expiresAt || 0;
}

export async function getAuthenticatedContext(userId?: string): Promise<BrowserContext> {
  // Load credentials
  const credentials = await getD2LCredentials(userId);
  const D2L_HOST = credentials?.host || process.env.D2L_HOST || "learn.ul.ie";
  const username = credentials?.username || process.env.D2L_USERNAME;
  const password = credentials?.password || process.env.D2L_PASSWORD;
  const HOME_URL = `https://${D2L_HOST}/d2l/home`;
  const sessionPath = getSessionPath(userId);
  
  const hasExistingSession = existsSync(sessionPath);
  const isProductionEnv = process.env.NODE_ENV === "production" || !process.env.DISPLAY;

  // In production, always use headless mode
  const headlessMode = isProductionEnv || hasExistingSession;

  const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium";
  let context = await chromium.launchPersistentContext(sessionPath, {
    headless: headlessMode,
    executablePath: chromiumPath,
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  // Go to home to check auth status
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });

  let currentUrl = page.url();
  if (isLoginPage(currentUrl)) {
    // If username and password are provided via env vars, use them for login
    if (username && password) {
      try {
        // Try to find and fill username field
        const usernameSelectors = [
          "input#userNameInput", // Microsoft ADFS
          'input[name="UserName"]', // Microsoft ADFS
          'input[type="email"]',
          'input[placeholder*="username" i]',
          'input[placeholder*="user" i]',
          'input[placeholder*="MyCarletonOne" i]',
          'input[name="userName"]',
          'input[name="username"]',
          'input[name="user"]',
          'input[type="text"][id*="user"]',
          'input[type="text"][id*="User"]',
          "input#userName",
          "input#username",
        ];

        const passwordSelectors = [
          "input#passwordInput", // Microsoft ADFS
          'input[name="Password"]', // Microsoft ADFS
          'input[type="password"][placeholder*="password" i]',
          'input[type="password"][placeholder*="Password" i]',
          'input[name="password"]',
          'input[name="passWord"]',
          'input[type="password"]',
          "input#password",
          "input#passWord",
        ];

        let usernameField = null;
        let passwordField = null;

        for (const selector of usernameSelectors) {
          try {
            const field = page.locator(selector);
            if (await field.isVisible({ timeout: 2000 })) {
              usernameField = field;
              break;
            }
          } catch {
            continue;
          }
        }

        if (!usernameField) {
          throw new Error("Could not find username field");
        }

        // Fill username first
        await usernameField.fill(username);
        
        // Look for Next button in multi-step forms
        const nextButtonSelectors = [
          'input[type="submit"]',
          'button[type="submit"]',
          'input[value*="Next" i]',
          'button:has-text("Next")',
          'button:has-text("Continue")',
          'input[value*="Continue" i]',
          'button:has-text("Submit")',
          '#submitButton',
        ];
        
        let nextButtonClicked = false;
        for (const selector of nextButtonSelectors) {
          try {
            const nextButton = page.locator(selector).first();
            if (await nextButton.isVisible({ timeout: 1000 })) {
              await nextButton.click();
              nextButtonClicked = true;
              await page.waitForTimeout(2000);
              break;
            }
          } catch {
            continue;
          }
        }
        
        if (!nextButtonClicked) {
          await usernameField.press("Enter");
          await page.waitForTimeout(2000);
        }

        // Now find password field
        for (const selector of passwordSelectors) {
          try {
            const field = page.locator(selector);
            if (await field.isVisible({ timeout: 3000 })) {
              passwordField = field;
              break;
            }
          } catch {
            continue;
          }
        }

        if (!passwordField) {
          throw new Error("Could not find password field");
        }

        await passwordField.fill(password);

        const submitSelectors = [
          'input[type="submit"]',
          'button[type="submit"]',
          'button:has-text("Log in")',
          'button:has-text("Login")',
          'button:has-text("Sign in")',
          'button:has-text("Sign In")',
          'input[value*="Sign in" i]',
          'input[value*="Log in" i]',
          "form button",
          'form input[type="submit"]',
        ];

        let submitted = false;
        for (const selector of submitSelectors) {
          try {
            const submitButton = page.locator(selector).first();
            if (await submitButton.isVisible({ timeout: 1000 })) {
              await submitButton.click();
              submitted = true;
              break;
            }
          } catch {
            continue;
          }
        }

        if (!submitted) {
          try {
            // Try submitting the form directly
            await page.evaluate(() => {
              const form = document.querySelector('form');
              if (form) {
                form.submit();
                return;
              }
            });
            await page.waitForTimeout(1000);
          } catch {
            // Fallback to pressing Enter
            await passwordField.press("Enter");
          }
        }

        await page.waitForURL((url) => !isLoginPage(url.toString()), {
          timeout: 60000,
        });
        await page.waitForLoadState("domcontentloaded");
      } catch (error) {
        console.error("Form login failed:", error);
      }
    } else {
      // No credentials provided, try SSO button
      try {
        const ssoButton = page.locator(
          'button.d2l-button-sso-1, button:has-text("Student & Staff Login")'
        );
        if (await ssoButton.isVisible({ timeout: 2000 })) {
          await ssoButton.click();
          await page.waitForURL((url) => !isLoginPage(url.toString()), {
            timeout: hasExistingSession ? 15000 : 60000,
          });
          await page.waitForLoadState("domcontentloaded");
        }
      } catch {
        // If headless failed to auto-login, restart with visible browser (only in non-production)
        const isProductionEnv = process.env.NODE_ENV === "production" || !process.env.DISPLAY;
        if (hasExistingSession && !isProductionEnv) {
          await context.close();
          console.error("Session expired, opening browser for login...");
          context = await chromium.launchPersistentContext(sessionPath, {
            headless: false,
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
            viewport: { width: 1280, height: 720 },
          });
          const newPage = await context.newPage();
          await newPage.goto(HOME_URL, { waitUntil: "domcontentloaded" });

          // Wait for user to complete login
          await newPage.waitForURL((url) => !isLoginPage(url.toString()), {
            timeout: 120000,
          });
          await newPage.close();
        } else if (hasExistingSession && isProductionEnv) {
          // In production, cannot handle login - throw error
          await context.close();
          throw new Error("REAUTH_REQUIRED");
        }
      }
    }
  }

  await page.close();
  return context;
}
