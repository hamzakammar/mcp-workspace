import { getD2LToken, isDuoRequired } from '../auth.js';
import { getUserId } from '../utils/userContext.js';
import { supabase } from '../utils/supabase.js';
import { D2LClient } from '../client.js';

const STORAGE_STATE_TTL_DAYS = 25;

async function getPiazzaConnected(userId: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('user_credentials')
      .select('token')
      .eq('user_id', userId)
      .eq('service', 'piazza')
      .limit(1)
      .single();
    return !!data?.token;
  } catch {
    return false;
  }
}

async function getCoursesAccessible(userId: string, host: string): Promise<number> {
  try {
    const d2lClient = new D2LClient(userId, host);
    const enrollments = (await d2lClient.getMyEnrollments()) as { Items?: unknown[] };
    return Array.isArray(enrollments.Items) ? enrollments.Items.length : 0;
  } catch {
    return 0;
  }
}

export const statusTools = {
  get_horizon_status: {
    description: `Check the current connection and authentication status of Horizon. Returns whether D2L and Piazza are connected, whether the session is healthy, how many courses are accessible, when the session was last refreshed, and how many days remain before Duo re-authentication is required. Use this as the first tool to call when something feels wrong.`,
    schema: {},
    handler: async (): Promise<string> => {
      const userId = getUserId() || 'legacy';

      // Fetch D2L token row
      const tokenRow = await getD2LToken(userId).catch(() => null);
      const d2lConnected = !!tokenRow?.token;
      const lastSessionRefresh = tokenRow?.updated_at || null;

      // Calculate days until Duo required (25-day TTL from last refresh)
      let daysUntilDuoRequired: number | null = null;
      if (lastSessionRefresh) {
        const refreshedAt = new Date(lastSessionRefresh).getTime();
        const expiresAt = refreshedAt + STORAGE_STATE_TTL_DAYS * 24 * 60 * 60 * 1000;
        daysUntilDuoRequired = Math.max(
          0,
          Math.round((expiresAt - Date.now()) / (24 * 60 * 60 * 1000))
        );
      }

      // Check session health (lightweight whoami ping)
      let sessionHealthy = false;
      if (d2lConnected && tokenRow) {
        try {
          const d2lClient = new D2LClient(userId, tokenRow.host);
          await d2lClient.whoami();
          sessionHealthy = true;
        } catch {
          sessionHealthy = false;
        }
      }

      // Check if Duo re-auth is pending
      const duoRequired = userId !== 'legacy'
        ? await isDuoRequired(userId).catch(() => false)
        : false;

      // Count accessible courses
      const coursesAccessible = d2lConnected && sessionHealthy && tokenRow
        ? await getCoursesAccessible(userId, tokenRow.host)
        : 0;

      // Check Piazza connection
      const piazzaConnected = userId !== 'legacy'
        ? await getPiazzaConnected(userId)
        : false;

      const result = {
        d2l_connected: d2lConnected,
        session_healthy: sessionHealthy && !duoRequired,
        duo_reauth_required: duoRequired,
        courses_accessible: coursesAccessible,
        piazza_connected: piazzaConnected,
        last_session_refresh: lastSessionRefresh,
        days_until_duo_required: daysUntilDuoRequired,
      };

      return JSON.stringify(result, null, 2);
    },
  },
};
