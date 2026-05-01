/**
 * Session Refresher — headless D2L cookie auto-refresh.
 *
 * Uses saved ADFS browser state from S3 to silently refresh D2L session
 * cookies without Duo MFA. If ADFS state has expired (30-90 days),
 * sends a push notification asking the user to re-auth manually.
 *
 * Two entry points:
 *   - refreshD2LSession(userId)  — on-demand refresh (called from auth.ts)
 *   - startSessionRefreshScheduler() — background scheduler (called from index.ts)
 */

import { chromium } from "playwright";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { supabase } from "../utils/supabase.js";
import { loadStorageStateFromS3, saveStorageStateToS3 } from "../utils/s3Storage.js";
import { sendPushToUser } from "../api/push.js";
import { getD2LCredentials } from "../auth.js";

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium";
const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // check every 30 min
const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000; // refresh if token older than 12h
const NAV_TIMEOUT_MS = 30_000; // 30s page load timeout

export interface RefreshResult {
  success: boolean;
  reason?: "no_stored_state" | "duo_required" | "nav_failed" | "no_cookies" | "error";
  error?: string;
}

/**
 * Attempt a headless credential-based D2L login for a user.
 * Used as a fallback when ADFS browser state is absent or expired.
 * On success: upserts token to DB, saves new browser state to S3, clears duo_required_at.
 * Returns { token, storageStatePath } on success, null if Duo wall hit or no creds stored.
 */
async function attemptCredentialLogin(
  userId: string,
  d2lHost: string,
  storageStatePath?: string
): Promise<{ token: string; storageStatePath: string } | null> {
  const creds = await getD2LCredentials(userId);
  if (!creds?.username || !creds?.password) {
    console.error(`[REFRESH] No stored credentials for user ${userId} — cannot attempt credential login`);
    return null;
  }

  console.error(`[REFRESH] Attempting credential-based login for user ${userId}`);

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    // Use S3 storage state so the Duo "remember this device" cookie is present.
    // Without it, Duo sees a fresh browser and requires a new challenge every time.
    const context = await browser.newContext(
      storageStatePath ? { storageState: storageStatePath } : {}
    );
    const page = await context.newPage();

    await page.goto(`https://${d2lHost}/d2l/home`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    await page.waitForTimeout(3000);

    const landingUrl = page.url();
    console.error(`[REFRESH] Credential login landing URL for user ${userId}: ${landingUrl}`);

    // If Duo wall — cannot proceed headlessly
    if (landingUrl.includes("duo") || landingUrl.includes("duosecurity")) {
      console.error(`[REFRESH] Credential login hit Duo wall for user ${userId}`);
      await browser.close();
      return null;
    }

    // If on a username/password form — fill credentials
    if (
      landingUrl.includes("adfs") ||
      landingUrl.includes("login") ||
      landingUrl.includes("saml") ||
      landingUrl.includes("microsoftonline") ||
      landingUrl.includes("sso")
    ) {
      // Record pre-login D2L cookie values so we can detect whether login actually succeeded
      const preCookies = await context.cookies();
      const preSessionVal = preCookies.find(c => c.name === "d2lSessionVal" && c.domain.includes(d2lHost))?.value;
      const preSecureVal = preCookies.find(c => c.name === "d2lSecureSessionVal" && c.domain.includes(d2lHost))?.value;

      console.error(`[REFRESH] Filling credentials for user ${userId}`);
      // UWaterloo ADFS requires full UPN format (user@uwaterloo.ca)
      const loginUsername = creds.username.includes('@') ? creds.username : `${creds.username}@uwaterloo.ca`;
      console.error(`[REFRESH] Using login username: ${loginUsername} (stored: ${creds.username})`);
      await page.fill('input[type="text"], input[name="UserName"], input[name="username"]', loginUsername).catch(() => {});

      // If password field is already visible (single-page ADFS form), skip the "Next" step.
      // If not visible, we need to advance to the password page first.
      const passwordVisible = await page.locator('input[type="password"]').isVisible({ timeout: 500 }).catch(() => false);
      if (!passwordVisible) {
        // Multi-step form: click a specific Next/Continue button (NOT a generic submit,
        // which would submit the form with only the username filled).
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
          // Press Enter on the username field specifically (not a global keyboard event)
          await page.locator('input[name="UserName"], input[type="text"]').first().press("Enter").catch(() => {
            page.keyboard.press("Enter");
          });
        }
        // Wait for password field to appear
        await page.waitForSelector('input[type="password"]', { timeout: 5000 }).catch(() => {});
      }

      await page.fill('input[type="password"], input[name="Password"], input[name="password"]', creds.password).catch(() => {});

      const submitSelectors = [
        'input[type="submit"]',
        'button[type="submit"]',
        'button:has-text("Sign in")',
        'button:has-text("Log in")',
        '#submitButton',
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
      // Once Duo approves, ADFS issues the SAML assertion and redirects to D2L.
      try {
        await page.waitForURL(
          url => !url.hostname.includes("adfs.uwaterloo.ca"),
          { timeout: 35000 }
        );
        // Give D2L a moment to set session cookies after the SAML assertion
        await page.waitForTimeout(2000);
      } catch {
        // Still on ADFS after 35s — fall through, check cookies below
      }

      const postLoginUrl = page.url();
      console.error(`[REFRESH] Post-credential URL for user ${userId}: ${postLoginUrl}`);

      // Verify D2L cookies actually changed (new session was established).
      // If unchanged, the login didn't complete — old cookies from S3 state are not valid.
      const postCookies = await context.cookies();
      const postSessionVal = postCookies.find(c => c.name === "d2lSessionVal" && c.domain.includes(d2lHost))?.value;
      const postSecureVal = postCookies.find(c => c.name === "d2lSecureSessionVal" && c.domain.includes(d2lHost))?.value;

      if (!postSessionVal || !postSecureVal || (postSessionVal === preSessionVal && postSecureVal === preSecureVal)) {
        const pageTitle = await page.title().catch(() => "unknown");
        console.error(`[REFRESH] Credential login failed for user ${userId} — cookies unchanged, page="${pageTitle}"`);
        await browser.close();
        return null;
      }

      const token = JSON.stringify({ d2lSessionVal: postSessionVal, d2lSecureSessionVal: postSecureVal });

      // Save browser storage state to S3
      const tmpStatePath = path.join(os.tmpdir(), `cred-login-state-${userId}.json`);
      await context.storageState({ path: tmpStatePath });
      await saveStorageStateToS3(userId, tmpStatePath);
      await fs.unlink(tmpStatePath).catch(() => {});

      // Upsert fresh token and clear duo_required_at
      const { error } = await supabase.from("user_credentials").upsert({
        user_id: userId,
        service: "d2l",
        host: d2lHost,
        token,
        duo_required_at: null,
        notification_sent_at: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,service" });

      if (error) {
        console.error(`[REFRESH] Failed to store credential-login token for user ${userId}:`, error.message);
      }

      await browser.close();
      console.error(`[REFRESH] Credential login succeeded for user ${userId}`);
      return { token, storageStatePath: tmpStatePath };
    }

    // If we landed directly on D2L (S3 state had valid D2L cookies), extract them
    const cookies = await context.cookies();
    const sessionVal = cookies.find(c => c.name === "d2lSessionVal" && c.domain.includes(d2lHost))?.value;
    const secureVal = cookies.find(c => c.name === "d2lSecureSessionVal" && c.domain.includes(d2lHost))?.value;

    if (!sessionVal || !secureVal) {
      const pageTitle = await page.title().catch(() => "unknown");
      console.error(`[REFRESH] Credential login: no D2L cookies for user ${userId} — page="${pageTitle}" url=${page.url()}`);
      await browser.close();
      return null;
    }

    // Save browser storage state to S3
    const tmpStatePath = path.join(os.tmpdir(), `cred-login-state-${userId}.json`);
    await context.storageState({ path: tmpStatePath });
    await saveStorageStateToS3(userId, tmpStatePath);
    await fs.unlink(tmpStatePath).catch(() => {});

    const token = JSON.stringify({ d2lSessionVal: sessionVal, d2lSecureSessionVal: secureVal });

    // Upsert fresh token and clear duo_required_at
    const { error } = await supabase.from("user_credentials").upsert({
      user_id: userId,
      service: "d2l",
      host: d2lHost,
      token,
      duo_required_at: null,
      notification_sent_at: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,service" });

    if (error) {
      console.error(`[REFRESH] Failed to store credential-login token for user ${userId}:`, error.message);
    }

    await browser.close();
    console.error(`[REFRESH] Credential login succeeded for user ${userId}`);
    return { token, storageStatePath: tmpStatePath };

  } catch (err: any) {
    console.error(`[REFRESH] Credential login error for user ${userId}:`, err?.message);
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

/**
 * Ping the D2L API with stored session cookies to check if the session is still alive.
 * Returns the token to persist (possibly updated with rotated cookies from Set-Cookie headers),
 * or null if the session is dead.
 */
async function pingD2LSession(
  userId: string,
  d2lHost: string,
  currentToken: string
): Promise<string | null> {
  let cookieHeader = "";
  let existingCookies: { d2lSessionVal: string; d2lSecureSessionVal: string } | null = null;
  try {
    existingCookies = JSON.parse(currentToken);
    if (existingCookies?.d2lSessionVal && existingCookies?.d2lSecureSessionVal) {
      cookieHeader = `d2lSessionVal=${existingCookies.d2lSessionVal}; d2lSecureSessionVal=${existingCookies.d2lSecureSessionVal}`;
    }
  } catch { /* not a cookie token */ }

  if (!cookieHeader) return null;

  try {
    const pingResp = await fetch(`https://${d2lHost}/d2l/api/lp/1.43/users/whoami`, {
      headers: { "Cookie": cookieHeader },
      redirect: "manual",
    });

    if (pingResp.status < 200 || pingResp.status >= 300) {
      console.error(`[REFRESH] API ping returned ${pingResp.status} for user ${userId} — session dead`);
      return null;
    }

    // Session alive — check for rotated cookies in Set-Cookie response header
    const setCookie = pingResp.headers.get("set-cookie");
    console.error(`[REFRESH] Ping 200 for user ${userId} — Set-Cookie: ${setCookie ? setCookie.substring(0, 120) : "none"}`);
    if (setCookie && existingCookies) {
      let newSessionVal: string | undefined;
      let newSecureVal: string | undefined;
      // Node Fetch joins multiple Set-Cookie values with ", " — split carefully on cookie boundaries
      for (const part of setCookie.split(/,\s*(?=[^;]+=)/)) {
        const m = part.match(/^([^=\s]+)=([^;]*)/);
        if (!m) continue;
        const [, name, value] = m;
        if (name === "d2lSessionVal") newSessionVal = value;
        if (name === "d2lSecureSessionVal") newSecureVal = value;
      }
      if (newSessionVal || newSecureVal) {
        console.error(`[REFRESH] Captured rotated D2L cookies for user ${userId}`);
        return JSON.stringify({
          d2lSessionVal: newSessionVal || existingCookies.d2lSessionVal,
          d2lSecureSessionVal: newSecureVal || existingCookies.d2lSecureSessionVal,
        });
      }
    }

    return currentToken; // session alive, cookies unchanged
  } catch (e: any) {
    console.error(`[REFRESH] API ping error for user ${userId}: ${e.message}`);
    return null;
  }
}

/**
 * Attempt to refresh a user's D2L session cookies.
 * First tries a lightweight API ping — if the session is still alive, just update updated_at.
 * Falls back to headless browser with S3 ADFS state, then credential login.
 * No VNC, no Xvfb — fully headless.
 */
export async function refreshD2LSession(userId: string): Promise<RefreshResult> {
  const startTime = Date.now();
  console.error(`[REFRESH] Starting headless refresh for user ${userId}`);

  // 1. Load current credentials from DB (host + token + duo_required_at)
  let d2lHost = process.env.D2L_HOST || "learn.uwaterloo.ca";
  let currentToken: string | null = null;
  try {
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    if (sbUrl && sbKey) {
      const resp = await fetch(`${sbUrl}/rest/v1/user_credentials?user_id=eq.${userId}&service=eq.d2l&select=host,token,duo_required_at&limit=1`, {
        headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` },
      });
      if (resp.ok) {
        const rows = await resp.json() as Array<{ host: string; token: string; duo_required_at: string | null }>;
        if (rows.length > 0) {
          if (rows[0].host) d2lHost = rows[0].host;
          if (rows[0].token) currentToken = rows[0].token;
          // Hard stop: if duo_required is already set, don't attempt headless refresh.
          // Any browser-based attempt would trigger another Duo push on the user's phone.
          if (rows[0].duo_required_at) {
            console.error(`[REFRESH] Skipping user ${userId} — duo_required_at is set, manual re-auth needed`);
            return { success: false, reason: "duo_required" };
          }
        }
      }
    }
  } catch (e) {
    console.error("[REFRESH] Error fetching D2L credentials:", e);
  }

  // 2. API ping — if the stored session cookies still work, no browser needed
  if (currentToken) {
    const pingedToken = await pingD2LSession(userId, d2lHost, currentToken);
    if (pingedToken !== null) {
      const { error } = await supabase.from("user_credentials").upsert({
        user_id: userId,
        service: "d2l",
        host: d2lHost,
        token: pingedToken,
        duo_required_at: null,
        notification_sent_at: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,service" });
      if (error) console.error(`[REFRESH] Failed to update token after API ping for user ${userId}:`, error.message);
      const durationMs = Date.now() - startTime;
      console.error(`[REFRESH] API ping succeeded for user ${userId} — session alive (${durationMs}ms)`);
      return { success: true };
    }
    console.error(`[REFRESH] API ping failed for user ${userId} — session expired, falling back to browser refresh`);
  }

  // 4. Load saved ADFS browser state from S3.
  // rejectIfLegacy=true: legacy (unencrypted) states are old enough that ADFS is almost
  // certainly expired, so using them in a headless browser would trigger a real Duo push
  // on the user's phone. Skip straight to credential login instead.
  const storageStatePath = await loadStorageStateFromS3(userId, undefined, { rejectIfLegacy: true });
  if (!storageStatePath) {
    console.error(`[REFRESH] No usable browser state for user ${userId} — trying credential login`);
    const credResult = await attemptCredentialLogin(userId, d2lHost);
    if (credResult) {
      console.error(`[REFRESH] Credential login succeeded for user ${userId} (no prior S3 state)`);
      return { success: true };
    }
    console.error(`[REFRESH] Credential login failed for user ${userId} — marking duo_required`);
    return { success: false, reason: "no_stored_state" };
  }

  let browser;
  try {
    // 3. Launch headless Playwright — no display needed
    browser = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const context = await browser.newContext({
      storageState: storageStatePath,
    });

    const page = await context.newPage();

    // Block Duo push endpoints — if ADFS tries to trigger MFA in headless mode,
    // abort the request rather than sending a real push to the user's phone.
    await page.route(/duosecurity\.com|duoapi\.net/, route => {
      console.error(`[REFRESH] Blocked Duo endpoint in headless browser for user ${userId}: ${route.request().url()}`);
      route.abort();
    });

    // 4. Navigate to D2L — ADFS cookies should auto-login if still valid
    await page.goto(`https://${d2lHost}/d2l/home`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });

    // Give redirects time to settle
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    console.error(`[REFRESH] Final URL for user ${userId}: ${finalUrl}`);

    // 5. Check if we landed on a login page (ADFS expired, Duo needed)
    const isLoginPage =
      finalUrl.includes("login") ||
      finalUrl.includes("microsoftonline") ||
      finalUrl.includes("sso") ||
      finalUrl.includes("adfs");

    if (isLoginPage) {
      console.error(`[REFRESH] ADFS session expired for user ${userId} — trying credential login with S3 state (Duo cookie)`);
      await browser.close();
      browser = undefined;
      const credResult = await attemptCredentialLogin(userId, d2lHost, storageStatePath);
      if (credResult) {
        console.error(`[REFRESH] Credential login succeeded for user ${userId} (ADFS state expired)`);
        return { success: true };
      }
      console.error(`[REFRESH] Credential login failed for user ${userId} — marking duo_required`);
      return { success: false, reason: "duo_required" };
    }

    // 6. Extract D2L session cookies
    const cookies = await context.cookies();
    const sessionVal = cookies.find(c => c.name === "d2lSessionVal" && c.domain.includes(d2lHost))?.value;
    const secureVal = cookies.find(c => c.name === "d2lSecureSessionVal" && c.domain.includes(d2lHost))?.value;

    if (!sessionVal || !secureVal) {
      console.error(`[REFRESH] Missing D2L cookies for user ${userId} after navigation`);
      await browser.close();
      return { success: false, reason: "no_cookies" };
    }

    // 7. Save refreshed storage state back to S3 (extends ADFS lifetime)
    const tmpStatePath = path.join(os.tmpdir(), `refresh-state-${userId}.json`);
    await context.storageState({ path: tmpStatePath });
    await saveStorageStateToS3(userId, tmpStatePath);
    await fs.unlink(tmpStatePath).catch(() => {});

    // 8. Upsert fresh D2L token into database (clear duo_required_at if set)
    const token = JSON.stringify({ d2lSessionVal: sessionVal, d2lSecureSessionVal: secureVal });
    const { error } = await supabase.from("user_credentials").upsert({
      user_id: userId,
      service: "d2l",
      host: d2lHost,
      token,
      duo_required_at: null,
      notification_sent_at: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,service" });

    if (error) {
      console.error(`[REFRESH] Failed to store refreshed token for user ${userId}:`, error.message);
    }

    await browser.close();

    const durationMs = Date.now() - startTime;
    console.error(`[REFRESH] Successfully refreshed D2L session for user ${userId} (${durationMs}ms)`);
    return { success: true };

  } catch (err: any) {
    console.error(`[REFRESH] Error refreshing session for user ${userId}:`, err?.message);
    if (browser) {
      await browser.close().catch(() => {});
    }
    return { success: false, reason: "error", error: err?.message };
  }
}

/**
 * Background scheduler that proactively refreshes stale D2L sessions.
 * Runs every 30 minutes, checks all users with D2L credentials older than 18 hours.
 */
export function startSessionRefreshScheduler(): void {
  console.error("[REFRESH] Session refresh scheduler started (interval: 30min, threshold: 12h)");

  const runRefreshCycle = async () => {
    try {
      const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

      // Only refresh sessions that are stale AND have not already been flagged for Duo.
      // Users with duo_required_at set need manual VNC re-auth — retrying headless will
      // just trigger another Duo push notification on their phone.
      const { data: staleUsers, error } = await supabase
        .from("user_credentials")
        .select("user_id, updated_at")
        .eq("service", "d2l")
        .lt("updated_at", cutoff)
        .is("duo_required_at", null);

      if (error) {
        console.error("[REFRESH] Failed to query stale sessions:", error.message);
        return;
      }

      if (!staleUsers || staleUsers.length === 0) {
        console.error("[REFRESH] No stale sessions found");
        return;
      }

      console.error(`[REFRESH] Found ${staleUsers.length} stale session(s), refreshing...`);

      for (const user of staleUsers) {
        const result = await refreshD2LSession(user.user_id);

        if (!result.success && (result.reason === "duo_required" || result.reason === "no_stored_state")) {
          sendPushToUser(
            user.user_id,
            "D2L Session Expired",
            "Your D2L connection needs re-authentication. Open Horizon to reconnect.",
            { type: "reauth_required" }
          ).catch(err => {
            console.error(`[REFRESH] Failed to send push to user ${user.user_id}:`, err?.message);
          });
        }
      }
    } catch (err: any) {
      console.error("[REFRESH] Scheduler cycle error:", err?.message);
    }
  };

  // Run first cycle after a short delay (let server finish starting)
  setTimeout(runRefreshCycle, 10_000);

  // Then run every 30 minutes
  setInterval(runRefreshCycle, REFRESH_INTERVAL_MS);
}
