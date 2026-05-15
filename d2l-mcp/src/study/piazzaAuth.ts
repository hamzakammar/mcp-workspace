import "dotenv/config";
import { chromium, BrowserContext } from "playwright";
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import { supabase } from "../utils/supabase.js";
import { decryptPassword } from "../utils/kms.js";
import { logCredentialAccess } from "../utils/auditLog.js";

// Get session path for a user (or default)
function getSessionPath(userId?: string): string {
  if (userId) {
    return join(homedir(), `.piazza-session-${userId}`);
  }
  return join(homedir(), ".piazza-session");
}

// Load Piazza credentials for a user from database, or fall back to env vars
async function getPiazzaCredentials(userId?: string): Promise<{ email: string; password: string } | null> {
  if (userId) {
    try {
      const { data, error } = await supabase
        .from("user_credentials")
        .select("email, password")
        .eq("user_id", userId)
        .eq("service", "piazza")
        .single();

      if (!error && data) {
        await logCredentialAccess(userId, "piazza_password", "read", "getPiazzaCredentials");
        return {
          email: data.email,
          password: data.password ? await decryptPassword(data.password) : data.password,
        };
      }
    } catch (e) {
      console.error("[PIAZZA_AUTH] Error loading Piazza credentials from DB:", e);
    }
  }

  // Fall back to environment variables (if they exist)
  const email = process.env.PIAZZA_USERNAME;
  const password = process.env.PIAZZA_PASSWORD;

  if (email && password) {
    return { email, password };
  }

  return null;
}

// Pick a URL that reliably requires auth and lands you inside Piazza when logged in.
// You can use piazza.com and then navigate to a class page after.
const PIAZZA_HOME = "https://piazza.com/";

const REMOTE_DEBUG = process.env.REMOTE_DEBUG === "true";

// Detect if we're on a login page OR if we're on the homepage without being logged in
function isLoginPage(url: string): boolean {
  const u = url.toLowerCase();
  return (
    u.includes("login") ||
    u.includes("sso") ||
    u.includes("adfs") ||
    u.includes("microsoftonline") ||
    u.includes("shibboleth") ||
    u.includes("saml")
  );
}

// Check if user is logged into Piazza by looking for authenticated elements
async function isLoggedIn(page: import("playwright").Page): Promise<boolean> {
  try {
    // If we're on a login/SSO page, not logged in
    if (isLoginPage(page.url())) return false;
    
    // If we're on a class page, we're logged in
    if (page.url().includes('/class/')) return true;
    
    // Check for elements that indicate NOT logged in (Login link on homepage)
    const loginLink = await page.$('a[href*="/account/login"]');
    if (loginLink) {
      return false;
    }
    
    // Check for dashboard/class elements that indicate logged in
    const loggedInIndicator = await page.$('#my_piazzas, .network-list, [data-pats="network_list"]');
    return loggedInIndicator !== null;
  } catch {
    return false;
  }
}

export async function getPiazzaAuthenticatedContext(userId?: string): Promise<BrowserContext> {
  const sessionPath = getSessionPath(userId);
  const hasExistingSession = existsSync(sessionPath);

  // Force headless in production/AWS (ECS Fargate can't display)
  const isProduction = process.env.NODE_ENV === "production" || process.env.AWS_EXECUTION_ENV !== undefined || !process.env.DISPLAY;
  const shouldBeHeadless = isProduction || (hasExistingSession && !REMOTE_DEBUG);

  const browserArgs: string[] = [];
  if (REMOTE_DEBUG) {
    browserArgs.push("--remote-debugging-port=9223", "--no-sandbox", "--disable-setuid-sandbox");
    console.error("[PIAZZA_AUTH] Remote debugging enabled on port 9223");
  }
  
  // Add headless args for production/AWS (same as D2L auth)
  if (isProduction) {
    browserArgs.push(
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=TranslateUI",
      "--disable-ipc-flooding-protection",
      "--single-process"
    );
  }

  // Try headless first only if we have an existing session or in production
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(sessionPath, {
      headless: shouldBeHeadless,
      viewport: { width: 1280, height: 720 },
      args: browserArgs.length > 0 ? browserArgs : undefined,
      executablePath: isProduction ? "/usr/bin/chromium-browser" : undefined,
    });
  } catch (error: any) {
    // If launch fails in production, try with more minimal args
    if (isProduction) {
      console.error("[PIAZZA_AUTH] Initial launch failed, retrying with minimal args:", error.message);
      context = await chromium.launchPersistentContext(sessionPath, {
        headless: true,
        viewport: { width: 1280, height: 720 },
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--single-process"],
        executablePath: "/usr/bin/chromium-browser",
      });
    } else {
      throw error;
    }
  }

  const page = await context.newPage();
  console.error(`[PIAZZA_AUTH] Navigating to ${PIAZZA_HOME}`);
  await page.goto(PIAZZA_HOME, { waitUntil: "networkidle" });

  // Check if we're actually logged in (not just on the homepage)
  const loggedIn = await isLoggedIn(page);
  console.error(`[PIAZZA_AUTH] Logged in: ${loggedIn}`);

  if (!loggedIn) {
    console.error(`[PIAZZA_AUTH] Login required`);

    // If we were headless, restart with visible browser for manual login (only if not in production)
    // In production, we cannot handle manual login - throw error
    // Use the isProduction variable already declared above (line 96)
    if (isProduction) {
      await context.close();
      throw new Error("Piazza session expired and manual login required, but running in production/AWS where browser login is not possible. Please re-authenticate via mobile app.");
    }
    
    if (hasExistingSession && !REMOTE_DEBUG) {
      await context.close();
      console.error("[PIAZZA_AUTH] Session expired, reopening browser for login...");
      context = await chromium.launchPersistentContext(sessionPath, {
        headless: false,
        viewport: { width: 1280, height: 720 },
        args: browserArgs.length ? browserArgs : undefined,
      });
      const page2 = await context.newPage();
      await page2.goto(PIAZZA_HOME, { waitUntil: "networkidle" });

      // Wait for user to log in - detect by checking for logged-in state
      console.error("[PIAZZA_AUTH] Please log in to Piazza in the browser window...");
      await page2.waitForFunction(() => {
        // Wait until we're on a class page or the homepage changes to show classes
        const onClassPage = window.location.href.includes('/class/');
        const hasClassList = document.querySelector('#my_piazzas, .network-list, [data-pats="network_list"]') !== null;
        return onClassPage || hasClassList;
      }, { timeout: 180000 });
      await page2.waitForLoadState("networkidle");
      await page2.close();
    } else {
      // First run or already headed: wait for manual login
      console.error("[PIAZZA_AUTH] Please log in to Piazza in the browser window...");
      await page.waitForFunction(() => {
        const onClassPage = window.location.href.includes('/class/');
        const hasClassList = document.querySelector('#my_piazzas, .network-list, [data-pats="network_list"]') !== null;
        return onClassPage || hasClassList;
      }, { timeout: 180000 });
      await page.waitForLoadState("networkidle");
    }
  }

  await page.close();
  return context;
}

export async function getPiazzaCookieHeader(userId?: string): Promise<string> {
  const isProduction = process.env.NODE_ENV === "production" || process.env.AWS_EXECUTION_ENV !== undefined || !process.env.DISPLAY;
  
  // First, try to get cookies from database (WebView login)
  // Use direct REST API — Supabase JS client has known issues in ECS
  if (userId) {
    try {
      const sbUrl = process.env.SUPABASE_URL;
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
      let cookieHeader: string | null = null;

      if (sbUrl && sbKey) {
        const restUrl = `${sbUrl}/rest/v1/user_credentials?user_id=eq.${userId}&service=eq.piazza&select=token&limit=1`;
        const restResp = await fetch(restUrl, {
          headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` },
        });
        if (restResp.ok) {
          const rows = await restResp.json() as Array<{ token: string }>;
          if (rows.length > 0 && rows[0].token) {
            cookieHeader = rows[0].token;
          }
        }
      }

      if (cookieHeader) {
        // Validate cookies before returning (check for session_id and test API call)
        if (cookieHeader.includes("session_id=")) {
          // Test cookie validity by making a lightweight API call
          try {
            const testResponse = await fetch("https://piazza.com/logic/api?method=network.get_my_feed", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "accept": "application/json",
                "cookie": cookieHeader,
              },
              body: JSON.stringify({ method: "network.get_my_feed", params: { limit: 1 } }),
            });

            const responseText = await testResponse.text();
            // If we get HTML, cookies are invalid
            if (responseText.trim().startsWith("<!DOCTYPE html") || responseText.trim().startsWith("<html")) {
              console.error("[PIAZZA_AUTH] Stored cookies are invalid (got HTML response)");
            } else if (testResponse.ok) {
              // Cookies are valid
              console.error("[PIAZZA_AUTH] Using validated cookies from database");
              return cookieHeader;
            } else {
              console.error("[PIAZZA_AUTH] Cookie validation failed with status:", testResponse.status);
            }
          } catch (validationError) {
            console.error("[PIAZZA_AUTH] Cookie validation error:", validationError);
          }
        } else {
          console.error("[PIAZZA_AUTH] Stored cookies missing session_id");
        }
      }
    } catch (e) {
      console.error("[PIAZZA_AUTH] Failed to get cookies from DB:", e);
    }
  }
  
  // Try credential-based login (email + password stored in DB)
  if (userId) {
    try {
      const sbUrl = process.env.SUPABASE_URL;
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
      if (sbUrl && sbKey) {
        const credUrl = `${sbUrl}/rest/v1/user_credentials?user_id=eq.${userId}&service=eq.piazza&select=email,password&limit=1`;
        const credResp = await fetch(credUrl, {
          headers: { "apikey": sbKey, "Authorization": `Bearer ${sbKey}` },
        });
        if (credResp.ok) {
          const rows = await credResp.json() as Array<{ email: string; password: string }>;
          if (rows.length > 0 && rows[0].email && rows[0].password) {
            const { decryptPassword } = await import("../utils/kms.js");
            const plainPassword = await decryptPassword(rows[0].password);
            console.error(`[PIAZZA_AUTH] Attempting credential login for ${rows[0].email}`);

            // Step 1: Get initial session cookie + CSRF token from login page
            const initResp = await fetch("https://piazza.com/account/login", {
              headers: { "Accept": "text/html" },
            });
            const initCookies = initResp.headers.getSetCookie?.() || [];
            let initSessionCookie = '';
            for (const sc of initCookies) {
              const nv = sc.split(';')[0];
              if (nv.includes('session_id')) initSessionCookie = nv;
            }
            if (!initSessionCookie) {
              const rawSC = initResp.headers.get('set-cookie') || '';
              const m = rawSC.match(/session_id=[^;]+/);
              if (m) initSessionCookie = m[0];
            }
            const csrfToken = initSessionCookie.split('=')[1] || '';

            // Step 2: Login with CSRF token + session cookie
            const loginResp = await fetch("https://piazza.com/logic/api?method=user.login", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "cookie": initSessionCookie,
                "csrf-token": csrfToken,
              },
              body: JSON.stringify({ method: "user.login", params: { email: rows[0].email, pass: plainPassword } }),
            });

            if (loginResp.ok) {
              // Check response body for session info
              const loginBody = await loginResp.text();
              console.error(`[PIAZZA_AUTH] Login response body (first 300): ${loginBody.slice(0, 300)}`);

              // Extract session cookies from Set-Cookie headers
              let setCookies = loginResp.headers.getSetCookie?.() || [];
              // Fallback: some environments don't support getSetCookie
              if (setCookies.length === 0) {
                const rawSetCookie = loginResp.headers.get('set-cookie') || '';
                setCookies = rawSetCookie.split(/,(?=\s*\w+=)/).map(s => s.trim()).filter(Boolean);
              }
              const cookieParts: string[] = [];
              for (const sc of setCookies) {
                const nameValue = sc.split(';')[0];
                if (nameValue) cookieParts.push(nameValue);
              }

              console.error(`[PIAZZA_AUTH] Raw Set-Cookie parts: ${cookieParts.join(' | ')}`);
              if (cookieParts.length > 0 && cookieParts.some(c => c.includes("session_id"))) {
                const newCookieHeader = cookieParts.join("; ");
                console.error(`[PIAZZA_AUTH] Credential login succeeded, got ${cookieParts.length} cookies`);

                // Store the fresh cookies in DB for next time
                await fetch(`${sbUrl}/rest/v1/user_credentials?user_id=eq.${userId}&service=eq.piazza`, {
                  method: "PATCH",
                  headers: {
                    "apikey": sbKey, "Authorization": `Bearer ${sbKey}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ token: newCookieHeader, updated_at: new Date().toISOString() }),
                });

                return newCookieHeader;
              } else {
                const body = await loginResp.text();
                console.error(`[PIAZZA_AUTH] Credential login response had no session cookie. Body: ${body.slice(0, 200)}`);
              }
            } else {
              console.error(`[PIAZZA_AUTH] Credential login failed with status ${loginResp.status}`);
            }
          }
        }
      }
    } catch (e) {
      console.error(`[PIAZZA_AUTH] Credential login error:`, e);
    }
  }

  // Fallback to browser-based auth (ONLY in non-production)
  if (isProduction) {
    throw new Error("Piazza authentication required but no valid cookies found. Please re-authenticate via mobile app WebView login.");
  }
  
  const context = await getPiazzaAuthenticatedContext(userId);
  try {
    const cookies = await context.cookies(["https://piazza.com"]);
    // Build a Cookie header: "name=value; name2=value2"
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } finally {
    await context.close();
  }
}
