import { z } from 'zod';
import { getUserId } from '../utils/userContext.js';
import {
  getCrowdmarkCookie,
  fetchCrowdmarkAssignments,
  fetchCrowdmarkResult,
  refreshCrowdmarkSession,
  CrowdmarkAuthError,
} from '../study/crowdmarkClient.js';

const AUTH_HINT =
  'To connect Crowdmark: visit the Horizon dashboard at /onboard and click "Connect" next to Crowdmark. ' +
  'A login browser will open — log in to app.crowdmark.com and the session will be captured automatically.';

async function getSessionCookie(userId: string): Promise<string | null> {
  const raw = await getCrowdmarkCookie(userId);
  if (!raw) return null;
  // The stored value is a full Cookie header string captured from the browser
  // (e.g. "name1=val1; name2=val2"). Use it as-is.
  return raw;
}

export const crowdmarkTools = {
  get_crowdmark_assignments: {
    description: `List all your graded assignments from Crowdmark. Returns assignment title, type, and course name. Requires a Crowdmark session cookie to be configured. Use get_crowdmark_feedback to retrieve scores and TA annotations for a specific assignment.`,
    schema: {},
    handler: async (): Promise<string> => {
      const userId = getUserId() || 'legacy';
      const cookie = await getSessionCookie(userId);
      if (!cookie) {
        return JSON.stringify({
          success: false,
          error: 'Crowdmark is not connected.',
          hint: AUTH_HINT,
        }, null, 2);
      }

      try {
        const assignments = await fetchCrowdmarkAssignments(cookie);
        return JSON.stringify({ success: true, assignments }, null, 2);
      } catch (e: unknown) {
        if (e instanceof CrowdmarkAuthError) {
          // Try silent headless refresh before giving up
          const freshCookie = await refreshCrowdmarkSession(userId);
          if (freshCookie) {
            try {
              const assignments = await fetchCrowdmarkAssignments(freshCookie);
              return JSON.stringify({ success: true, assignments }, null, 2);
            } catch {}
          }
          return JSON.stringify({
            success: false,
            error: 'Crowdmark session expired. Please reconnect.',
            hint: AUTH_HINT,
          }, null, 2);
        }
        const msg = e instanceof Error ? e.message : String(e);
        return JSON.stringify({ success: false, error: msg }, null, 2);
      }
    },
  },

  get_crowdmark_feedback: {
    description: `Get your score and TA feedback for a specific Crowdmark assignment. Returns total points, earned points, percentage, class average, and per-question TA annotations. Use get_crowdmark_assignments first to get the assignment ID.`,
    schema: {
      assignmentId: z.string().describe('The Crowdmark assignment ID from get_crowdmark_assignments.'),
    },
    handler: async (args: { assignmentId: string }): Promise<string> => {
      const userId = getUserId() || 'legacy';
      const cookie = await getSessionCookie(userId);
      if (!cookie) {
        return JSON.stringify({
          success: false,
          error: 'Crowdmark is not connected.',
          hint: AUTH_HINT,
        }, null, 2);
      }

      try {
        const result = await fetchCrowdmarkResult(cookie, args.assignmentId);
        return JSON.stringify({ success: true, result }, null, 2);
      } catch (e: unknown) {
        if (e instanceof CrowdmarkAuthError) {
          const freshCookie = await refreshCrowdmarkSession(userId);
          if (freshCookie) {
            try {
              const result = await fetchCrowdmarkResult(freshCookie, args.assignmentId);
              return JSON.stringify({ success: true, result }, null, 2);
            } catch {}
          }
          return JSON.stringify({
            success: false,
            error: 'Crowdmark session expired. Please reconnect.',
            hint: AUTH_HINT,
          }, null, 2);
        }
        const msg = e instanceof Error ? e.message : String(e);
        return JSON.stringify({ success: false, error: msg }, null, 2);
      }
    },
  },
};
