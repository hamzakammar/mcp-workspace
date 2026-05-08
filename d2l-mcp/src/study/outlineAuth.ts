/**
 * Outline Auth — headless login to outline.uwaterloo.ca via Duo OIDC SSO.
 *
 * outline.uwaterloo.ca uses Duo OIDC as its identity provider (separate from
 * D2L's ADFS+Duo flow). Credentials are shared (same WatIAM username/password)
 * but the session cookies are independent.
 *
 * Auth flow:
 *   1. Try stored sessionid cookie from DB — validate with a lightweight request
 *   2. If invalid/missing — headless Playwright login using stored credentials
 *      a. Load S3 browser state (outline-specific key) to reuse Duo session if available
 *      b. Navigate to outline.uwaterloo.ca → Duo OIDC → UW credential form
 *      c. Fill username + password using same ADFS form fill logic as sessionRefresher
 *      d. Wait for redirect back to outline.uwaterloo.ca (up to 35s for Duo)
 *      e. Extract Django sessionid cookie, save browser state to S3
 *      f. Upsert token to user_credentials (service='outline')
 */

import { chromium } from "playwright";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { supabase } from "../utils/supabase.js";
import { sendPushToUser } from "../api/push.js";

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium";
const OUTLINE_HOST = "outline.uwaterloo.ca";
const S3_STATE_KEY_PREFIX = "browser-state";
const NAV_TIMEOUT_MS = 30_000;
const DUO_WAIT_MS = 35_000;

// ─── S3 helpers (outline-specific key) ───────────────────────────────────────

async function loadOutlineStateFromS3(userId: string): Promise<string | undefined> {
  try {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
    const key = `${S3_STATE_KEY_PREFIX}/${userId}/outline-storage-state.json`;
    const res = await s3.send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET || "study-mcp-notes",
      Key: key,
    }));
    const body = await res.Body?.transformToString();
    if (!body) return undefined;
    const tmpPath = path.join(os.tmpdir(), `outline-state-${userId}.json`);
    await fs.writeFile(tmpPath, body);
    console.error(`[OUTLINE_AUTH] Loaded outline browser state for user ${userId}`);
    return tmpPath;
  } catch (e: any) {
    if (e?.name !== "NoSuchKey") {
      console.error(`[OUTLINE_AUTH] Failed to load outline browser state: ${e?.message}`);
    }
    return undefined;
  }
}

async function saveOutlineStateToS3(userId: string, statePath: string): Promise<void> {
  try {
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
    const key = `${S3_STATE_KEY_PREFIX}/${userId}/outline-storage-state.json`;
    const body = await fs.readFile(statePath, "utf-8");
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET || "study-mcp-notes",
      Key: key,
      Body: body,
      ContentType: "application/json",
    }));
    console.error(`[OUTLINE_AUTH] Saved outline browser state for user ${userId}`);
  } catch (e: any) {
    console.error(`[OUTLINE_AUTH] Failed to save outline browser state: ${e?.message}`);
  }
}

// ─── Credential retrieval ─────────────────────────────────────────────────────

async function getOutlineCredentials(userId: string): Promise<{ username: string; password: string } | null> {
  const { data, error } = await supabase
    .from("user_credentials")
    .select("username, password")
    .eq("user_id", userId)
    .eq("service", "outline")
    .single();

  if (error || !data?.username || !data?.password) return null;
  return { username: data.username, password: data.password };
}

// ─── Cookie validation ────────────────────────────────────────────────────────

async function validateOutlineCookie(sessionid: string): Promise<boolean> {
  try {
    const resp = await fetch(`https://${OUTLINE_HOST}/viewer/org/uwaterloo/`, {
      headers: { "Cookie": `sessionid=${sessionid}` },
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
    });
    const location = resp.headers.get("location") || "";
    // Hard redirect to OIDC login = cookie invalid
    if (location.includes("oidc/login") || location.includes("duosecurity") || location.includes("/login")) {
      return false;
    }
    // JS-redirect page: site returns 200 with a page that redirects to OIDC via JS
    if (resp.status === 200) {
      const html = await resp.text();
      if (html.includes('id="redirect-parent"') && (html.includes('/oidc/') || html.includes('duosecurity'))) {
        console.error(`[OUTLINE_AUTH] Cookie validation: JS redirect to OIDC — sessionid invalid`);
        return false;
      }
      return true;
    }
    // Any non-login redirect (e.g. to the viewer home) = valid
    return resp.status >= 300 && resp.status < 400;
  } catch (e: any) {
    console.error(`[OUTLINE_AUTH] Cookie validation network error: ${e?.message}`);
    return false;
  }
}

// ─── Get stored cookies ───────────────────────────────────────────────────────

/**
 * Retrieve a validated outline sessionid cookie for the user from DB.
 * Returns the cookie string (e.g. "sessionid=abc123") or null if missing/invalid.
 */
export async function getOutlineCookies(userId: string): Promise<string | null> {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
  if (!sbUrl || !sbKey) return null;

  try {
    const resp = await fetch(
      `${sbUrl}/rest/v1/user_credentials?user_id=eq.${userId}&service=eq.outline&select=token&limit=1`,
      { headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` } }
    );
    if (!resp.ok) return null;

    const rows = await resp.json() as Array<{ token: string }>;
    if (!rows.length || !rows[0].token) return null;

    let token: string;
    try {
      const parsed = JSON.parse(rows[0].token) as { sessionid?: string };
      if (!parsed.sessionid) return null;
      token = parsed.sessionid;
    } catch {
      return null;
    }

    const valid = await validateOutlineCookie(token);
    if (!valid) {
      console.error(`[OUTLINE_AUTH] Stored cookie invalid for user ${userId}`);
      return null;
    }

    return `sessionid=${token}`;
  } catch (e: any) {
    console.error(`[OUTLINE_AUTH] Error fetching outline token from DB: ${e?.message}`);
    return null;
  }
}

// ─── Headless login ───────────────────────────────────────────────────────────

/**
 * Perform a headless Playwright login to outline.uwaterloo.ca.
 * Uses the same WatIAM credentials as D2L (stored under service='outline').
 * On success: upserts sessionid to DB, saves browser state to S3.
 * Returns cookie string or null if Duo push wall hit.
 */
export async function loginToOutline(userId: string): Promise<string | null> {
  const creds = await getOutlineCredentials(userId);
  if (!creds) {
    console.error(`[OUTLINE_AUTH] No credentials stored for user ${userId} (service=outline)`);
    return null;
  }

  console.error(`[OUTLINE_AUTH] Starting headless outline login for user ${userId}`);

  const storageStatePath = await loadOutlineStateFromS3(userId);
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

    const context = await browser.newContext(
      storageStatePath ? { storageState: storageStatePath } : {}
    );
    const page = await context.newPage();

    // Navigate — this will redirect through Duo OIDC
    await page.goto(`https://${OUTLINE_HOST}/`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    await page.waitForTimeout(2000);

    const landingUrl = page.url();
    console.error(`[OUTLINE_AUTH] Landing URL for user ${userId}: ${landingUrl}`);

    // If we're already on outline.uwaterloo.ca, session from S3 state was valid
    if (landingUrl.includes(OUTLINE_HOST) && !landingUrl.includes("oidc/login")) {
      console.error(`[OUTLINE_AUTH] S3 browser state auto-authenticated for user ${userId}`);
      return await extractAndStoreSession(userId, context, page);
    }

    // If Duo is the wall (not the UW credential form), we can't proceed headlessly
    if (landingUrl.includes("duosecurity.com") && !landingUrl.includes("authorize")) {
      console.error(`[OUTLINE_AUTH] Duo push wall hit for user ${userId}`);
      await browser.close();
      await markDuoRequired(userId);
      return null;
    }

    // We're on a login/credential form — fill username + password
    if (
      landingUrl.includes("adfs") ||
      landingUrl.includes("login") ||
      landingUrl.includes("sso") ||
      landingUrl.includes("duosecurity") ||
      landingUrl.includes("microsoftonline")
    ) {
      const loginUsername = creds.username.includes("@")
        ? creds.username
        : `${creds.username}@uwaterloo.ca`;

      console.error(`[OUTLINE_AUTH] Filling credentials for user ${userId}`);

      // Fill username
      await page.fill(
        'input[type="text"], input[name="UserName"], input[name="username"], input[type="email"]',
        loginUsername
      ).catch(() => {});

      // Handle multi-step forms (username first, then password page)
      const passwordVisible = await page.locator('input[type="password"]').isVisible({ timeout: 500 }).catch(() => false);
      if (!passwordVisible) {
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
          await page.locator('input[name="UserName"], input[type="text"], input[type="email"]')
            .first().press("Enter").catch(() => page.keyboard.press("Enter"));
        }
        await page.waitForSelector('input[type="password"]', { timeout: 5000 }).catch(() => {});
      }

      // Fill password
      await page.fill(
        'input[type="password"], input[name="Password"], input[name="password"]',
        creds.password
      ).catch(() => {});

      // Submit
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
      if (!submitted) await page.keyboard.press("Enter");

      // Wait for redirect back to outline.uwaterloo.ca (Duo may take up to 35s)
      try {
        await page.waitForURL(
          url => url.hostname === OUTLINE_HOST,
          { timeout: DUO_WAIT_MS }
        );
        await page.waitForTimeout(1000);
      } catch {
        // Timed out — check current URL
        const currentUrl = page.url();
        if (!currentUrl.includes(OUTLINE_HOST)) {
          if (currentUrl.includes("duosecurity")) {
            console.error(`[OUTLINE_AUTH] Duo push required for user ${userId}`);
            await browser.close();
            await markDuoRequired(userId);
            return null;
          }
          console.error(`[OUTLINE_AUTH] Login timed out for user ${userId}, url=${currentUrl}`);
          await browser.close();
          return null;
        }
      }
    }

    return await extractAndStoreSession(userId, context, page);

  } catch (err: any) {
    console.error(`[OUTLINE_AUTH] Login error for user ${userId}: ${err?.message}`);
    if (browser) await browser.close().catch(() => {});
    return null;
  }

  async function extractAndStoreSession(
    uid: string,
    context: import("playwright").BrowserContext,
    page: import("playwright").Page
  ): Promise<string | null> {
    const cookies = await context.cookies([`https://${OUTLINE_HOST}`]);
    const sessionid = cookies.find(c => c.name === "sessionid" && c.domain.includes(OUTLINE_HOST))?.value;

    if (!sessionid) {
      console.error(`[OUTLINE_AUTH] No sessionid cookie found for user ${uid}`);
      await browser!.close();
      return null;
    }

    // Save browser state to S3 (outline-specific key)
    const tmpStatePath = path.join(os.tmpdir(), `outline-state-${uid}.json`);
    await context.storageState({ path: tmpStatePath });
    await saveOutlineStateToS3(uid, tmpStatePath);
    await fs.unlink(tmpStatePath).catch(() => {});

    // Upsert sessionid token to DB
    const { error } = await supabase.from("user_credentials").upsert({
      user_id: uid,
      service: "outline",
      host: OUTLINE_HOST,
      token: JSON.stringify({ sessionid }),
      duo_required_at: null,
      notification_sent_at: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,service" });

    if (error) {
      console.error(`[OUTLINE_AUTH] Failed to store outline token for user ${uid}: ${error.message}`);
    }

    await browser!.close();
    console.error(`[OUTLINE_AUTH] Login succeeded for user ${uid}`);
    return `sessionid=${sessionid}`;
  }
}

async function markDuoRequired(userId: string): Promise<void> {
  await supabase.from("user_credentials").upsert({
    user_id: userId,
    service: "outline",
    duo_required_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,service" });

  sendPushToUser(
    userId,
    "Outline Login Required",
    "Horizon needs to access your course outlines. Open the app to reconnect.",
    { type: "outline_reauth_required" }
  ).catch(() => {});
}

// ─── Main exported function ───────────────────────────────────────────────────

/**
 * Get a valid outline.uwaterloo.ca cookie for the user.
 * Tries DB first, falls back to headless login if expired/missing.
 * Returns cookie string (e.g. "sessionid=abc123") or throws if auth fails.
 */
export async function getOrRefreshOutlineCookies(userId: string): Promise<string> {
  const stored = await getOutlineCookies(userId);
  if (stored) return stored;

  console.error(`[OUTLINE_AUTH] No valid stored cookie for user ${userId}, attempting login`);
  const fresh = await loginToOutline(userId);
  if (fresh) return fresh;

  throw new Error(
    "Outline authentication failed. Please connect your outline.uwaterloo.ca account via the app."
  );
}
