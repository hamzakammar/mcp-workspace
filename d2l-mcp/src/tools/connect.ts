/**
 * connect.ts — MCP tools for connecting optional integrations without the browser.
 *
 * Claude can guide a user step-by-step to copy a session cookie from their browser
 * and then call these tools to store it, completing setup from within the conversation.
 *
 * Security note: cookie values are temporary session tokens, not passwords. They expire
 * with the session. For credential-based services (Piazza), users may prefer the dashboard.
 */

import { z } from 'zod';
import { getUserId } from '../utils/userContext.js';
import { supabase } from '../utils/supabase.js';
import { encryptPassword } from '../utils/kms.js';
import { logCredentialAccess } from '../utils/auditLog.js';

const DASHBOARD_URL = process.env.API_HOST
  ? `https://${process.env.API_HOST}/onboard`
  : 'https://horizon.hamzaammar.ca/onboard';

// ── shared helper ──────────────────────────────────────────────────────────────

async function upsertCredential(userId: string, service: string, fields: Record<string, unknown>): Promise<void> {
  const { error } = await supabase
    .from('user_credentials')
    .upsert({ user_id: userId, service, ...fields, updated_at: new Date().toISOString() }, { onConflict: 'user_id,service' });
  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
}

// ── tools ──────────────────────────────────────────────────────────────────────

export const connectTools = {

  connect_crowdmark: {
    description: `Connect your Crowdmark account so Horizon can fetch your graded assignments and TA feedback. The recommended way is via the Horizon dashboard (/onboard) — click Connect next to Crowdmark and log in through the browser that opens. If you must connect manually: paste a full Cookie header string captured from app.crowdmark.com (F12 → Network → any request → copy the Cookie request header value).`,
    schema: {
      cookie: z.string().describe('The value of the _crowdmark_session cookie from app.crowdmark.com. Get it from browser DevTools → Application → Cookies.'),
    },
    handler: async (args: { cookie: string }): Promise<string> => {
      const userId = getUserId();
      if (!userId || userId === 'legacy') {
        return JSON.stringify({ success: false, error: 'Could not determine user ID. Make sure you are authenticated.' });
      }

      const cookieHeader = args.cookie.includes('=') ? args.cookie : `_crowdmark_session=${args.cookie}`;

      // Quick validation
      try {
        const testRes = await fetch('https://app.crowdmark.com/api/v2/student/assignments?fields[exam-masters][]=title', {
          headers: { Cookie: cookieHeader, Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
        if (testRes.status === 401 || testRes.status === 403) {
          return JSON.stringify({ success: false, error: 'Cookie is invalid or expired. Please copy a fresh _crowdmark_session from DevTools.' });
        }
      } catch {
        // Network error — store anyway, will fail at use time
      }

      try {
        await upsertCredential(userId, 'crowdmark', { token: args.cookie });
        return JSON.stringify({ success: true, message: 'Crowdmark connected. You can now use get_crowdmark_assignments and get_crowdmark_feedback.' });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return JSON.stringify({ success: false, error: msg });
      }
    },
  },

  connect_outline: {
    description: `Connect course outlines from outline.uwaterloo.ca by pasting your session cookie. For a smoother experience, use the Horizon dashboard (/onboard) which opens a guided login browser — no DevTools needed. Manual steps if you prefer: 1) Open outline.uwaterloo.ca, log in with WatIAM + Duo. 2) F12 → Application → Cookies → outline.uwaterloo.ca. 3) Copy the value of sessionid. 4) Paste it here. Note: only works for University of Waterloo students.`,
    schema: {
      cookie: z.string().describe('The value of the sessionid cookie from outline.uwaterloo.ca. Get it from browser DevTools → Application → Cookies after logging in.'),
    },
    handler: async (args: { cookie: string }): Promise<string> => {
      const userId = getUserId();
      if (!userId || userId === 'legacy') {
        return JSON.stringify({ success: false, error: 'Could not determine user ID. Make sure you are authenticated.' });
      }

      // Strip "sessionid=" prefix if user pasted the full "name=value" string
      const sessionid = args.cookie.startsWith('sessionid=')
        ? args.cookie.slice('sessionid='.length)
        : args.cookie;

      // Quick validation — check the cookie works before saving
      try {
        const testRes = await fetch('https://outline.uwaterloo.ca/viewer/org/uwaterloo/', {
          headers: { Cookie: `sessionid=${sessionid}` },
          redirect: 'manual',
          signal: AbortSignal.timeout(8_000),
        });
        if (testRes.status === 301 || testRes.status === 302) {
          return JSON.stringify({ success: false, error: 'Cookie appears invalid — outline.uwaterloo.ca redirected to login. Copy a fresh sessionid after logging in.' });
        }
      } catch {
        // Network error — store anyway
      }

      try {
        await upsertCredential(userId, 'outline', { token: JSON.stringify({ sessionid }) });
        return JSON.stringify({ success: true, message: 'Course outlines connected. You can now use get_course_outline and get_my_course_outlines.' });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return JSON.stringify({ success: false, error: msg });
      }
    },
  },

  connect_piazza: {
    description: `Connect your Piazza account so Horizon can search and read your course Q&A posts. Provide your Piazza email and password. Note: your credentials will be visible in this conversation — if you prefer privacy, connect at the Horizon dashboard instead. Your password is encrypted with AWS KMS before storage and is never logged.`,
    schema: {
      email: z.string().email().describe('Your Piazza login email.'),
      password: z.string().describe('Your Piazza password.'),
    },
    handler: async (args: { email: string; password: string }): Promise<string> => {
      const userId = getUserId();
      if (!userId || userId === 'legacy') {
        return JSON.stringify({ success: false, error: 'Could not determine user ID. Make sure you are authenticated.' });
      }

      try {
        const encryptedPassword = await encryptPassword(args.password);
        await logCredentialAccess(userId, 'piazza_password', 'write', 'connect_piazza MCP tool');
        await upsertCredential(userId, 'piazza', { email: args.email, password: encryptedPassword });
        return JSON.stringify({
          success: true,
          message: `Piazza connected with ${args.email}. Your credentials are encrypted and stored. Use piazza_get_classes to verify the connection.`,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return JSON.stringify({ success: false, error: msg });
      }
    },
  },

  connect_notion: {
    description: `Connect your Notion workspace so Horizon can sync your D2L assignments into a Notion database. This uses Notion OAuth — the tool returns an authorization URL to open in your browser. After approving, you'll be redirected back and your token will be saved automatically. You'll then need your Notion database ID (from the database URL) to use sync_to_notion.`,
    schema: {},
    handler: async (): Promise<string> => {
      const userId = getUserId();
      if (!userId || userId === 'legacy') {
        return JSON.stringify({ success: false, error: 'Could not determine user ID. Make sure you are authenticated.' });
      }

      const clientId = process.env.NOTION_CLIENT_ID;
      const redirectUri = process.env.NOTION_REDIRECT_URI
        || (process.env.API_HOST
          ? `https://${process.env.API_HOST}/auth/notion/callback`
          : 'https://horizon.hamzaammar.ca/auth/notion/callback');

      if (!clientId) {
        return JSON.stringify({
          success: false,
          error: 'Notion OAuth is not configured on this server. Contact the administrator.',
        });
      }

      const state = Buffer.from(JSON.stringify({ userId, ts: Date.now() })).toString('base64url');
      const authUrl = `https://api.notion.com/v1/oauth/authorize?client_id=${encodeURIComponent(clientId)}&response_type=code&owner=user&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

      return JSON.stringify({
        success: true,
        action: 'open_url',
        url: authUrl,
        message: 'Open the URL below in your browser to authorize Notion. After approving, your token will be saved and you can use sync_to_notion.',
      }, null, 2);
    },
  },

  get_connection_guide: {
    description: `Get step-by-step instructions for connecting any optional Horizon integration. Returns instructions for Piazza, Crowdmark, and course outlines — either for the web dashboard or for connecting directly through Claude (MCP). Call this when a user asks how to connect a service or when a tool returns an auth error.`,
    schema: {
      service: z.enum(['piazza', 'crowdmark', 'outline', 'notion', 'all']).optional().describe('Which service to get instructions for. Defaults to all.'),
    },
    handler: async (args: { service?: string }): Promise<string> => {
      const guides: Record<string, object> = {
        piazza: {
          name: 'Piazza',
          connectViaClaude: {
            tool: 'connect_piazza',
            steps: ['Just say "connect my Piazza account" and provide your Piazza email and password when asked.'],
            note: 'Your password will be visible in the conversation. For privacy, use the dashboard.',
          },
          connectViaDashboard: {
            url: DASHBOARD_URL,
            steps: ['Visit the Horizon dashboard', 'Find "Piazza" in Connections', 'Click Connect and enter your email and password'],
          },
        },
        crowdmark: {
          name: 'Crowdmark',
          connectViaClaude: {
            tool: 'connect_crowdmark',
            steps: [
              '1. Open app.crowdmark.com in your browser and log in',
              '2. Press F12 to open DevTools',
              '3. Go to Application tab → Cookies → app.crowdmark.com',
              '4. Find _crowdmark_session and copy its value',
              '5. Tell Claude: "connect Crowdmark with cookie: <paste value>"',
            ],
          },
          connectViaDashboard: {
            url: DASHBOARD_URL,
            steps: ['Visit the Horizon dashboard', 'Find "Crowdmark" in Connections', 'Follow the cookie instructions and paste the value'],
          },
        },
        outline: {
          name: 'Course Outlines (UWaterloo)',
          connectViaClaude: {
            tool: 'connect_outline',
            steps: [
              '1. Open outline.uwaterloo.ca in your browser',
              '2. Log in with your WatIAM credentials and approve Duo',
              '3. Press F12 to open DevTools',
              '4. Go to Application tab → Cookies → outline.uwaterloo.ca',
              '5. Find sessionid and copy its value',
              '6. Tell Claude: "connect course outlines with cookie: <paste value>"',
            ],
            note: 'Only works for University of Waterloo students.',
          },
          connectViaDashboard: {
            url: DASHBOARD_URL,
            steps: ['Visit the Horizon dashboard', 'Find "UW Course Outlines" in Connections', 'Follow the cookie instructions and paste the value'],
          },
        },
      };

      guides['notion'] = {
        name: 'Notion',
        connectViaClaude: {
          tool: 'connect_notion',
          steps: [
            '1. Run connect_notion (no arguments needed)',
            '2. Open the returned URL in your browser and authorize Horizon',
            '3. Copy your Notion database ID from the database URL',
            '4. Run sync_to_notion with your database ID',
          ],
        },
        connectViaDashboard: {
          url: DASHBOARD_URL,
          steps: ['Visit the Horizon dashboard', 'Find "Notion" in Connections', 'Click Connect and authorize'],
        },
      };

      const target = args.service && args.service !== 'all' ? args.service : null;
      const result = target ? { [target]: guides[target] } : guides;

      return JSON.stringify({
        message: 'Use the MCP path to connect without leaving this conversation, or visit the dashboard for a guided UI.',
        dashboard: DASHBOARD_URL,
        guides: result,
      }, null, 2);
    },
  },
};
