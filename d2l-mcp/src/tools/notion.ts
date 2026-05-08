/**
 * Notion MCP tools — sync D2L assignments to a user's Notion database.
 *
 * Tools:
 *   sync_to_notion  — pulls all upcoming assignments across enrolled courses
 *                     and upserts them into a Notion database.
 */

import { z } from 'zod';
import { getUserId } from '../utils/userContext.js';
import { client } from '../client.js';
import { getNotionToken } from '../study/notionAuth.js';
import { syncAssignments, type NotionAssignment } from '../study/notionClient.js';

// ─── D2L raw types ────────────────────────────────────────────────────────────

interface RawEnrollment {
  OrgUnit: { Id: number; Name: string; Code: string; Type: { Code: string } };
  Access: { IsActive: boolean; CanAccess: boolean; StartDate: string | null; EndDate: string | null };
}

interface RawAssignment {
  Id: number;
  Name: string;
  DueDate: string | null;
  Assessment: { ScoreDenominator: number } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CONNECT_HINT =
  'Connect Notion via the Horizon dashboard (/onboard) — click "Connect" next to Notion, ' +
  'then authorise the integration and paste the database ID shown on the page.';

async function fetchCourseAssignments(
  orgUnitId: number,
  courseName: string,
  courseCode: string,
): Promise<NotionAssignment[]> {
  const assignments: NotionAssignment[] = [];
  try {
    const raw = (await client.getDropboxFolders(orgUnitId)) as RawAssignment[];
    const folders: RawAssignment[] = Array.isArray(raw) ? raw : [];
    for (const folder of folders) {
      if (!folder.DueDate) continue;
      assignments.push({
        title: folder.Name,
        courseName,
        courseCode,
        dueDate: folder.DueDate,
        type: 'assignment',
        status: 'Not Started',
        gradePercent: null,
        weightPercent: null,
      });
    }
  } catch {
    // course may not expose dropbox — skip
  }
  return assignments;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const notionTools = {
  sync_to_notion: {
    description:
      `Sync all your D2L assignments across every enrolled course into a Notion database. ` +
      `Creates new pages for assignments that don't exist yet and updates existing ones. ` +
      `Requires Notion to be connected via the dashboard (/onboard). ` +
      `Pass the Notion database ID (from the database URL or shown on the onboard page).`,
    schema: {
      databaseId: z
        .string()
        .describe(
          'The Notion database ID to sync into. Found in the database URL: ' +
          'notion.so/{workspace}/{DATABASE_ID}?v=...',
        ),
    },
    handler: async (args: { databaseId: string }): Promise<string> => {
      const userId = getUserId();

      // 1. Check Notion connection
      const notionToken = await getNotionToken(userId);
      if (!notionToken) {
        return JSON.stringify({
          success: false,
          error: 'Notion is not connected. Please connect your Notion account first.',
          hint: CONNECT_HINT,
        }, null, 2);
      }

      // 2. Fetch active enrollments
      let activeCourses: RawEnrollment[] = [];
      try {
        const enrollmentsRaw = (await client.getMyEnrollments()) as { Items: RawEnrollment[] };
        const now = new Date();
        const eightMonthsAgo = new Date(now.getTime() - 8 * 30 * 24 * 60 * 60 * 1000);
        activeCourses = (enrollmentsRaw.Items || []).filter((e) => {
          if (e.OrgUnit?.Type?.Code !== 'Course Offering') return false;
          if (!e.Access?.IsActive || !e.Access?.CanAccess) return false;
          const endDate = e.Access.EndDate ? new Date(e.Access.EndDate) : null;
          const startDate = e.Access.StartDate ? new Date(e.Access.StartDate) : null;
          if (endDate && endDate < eightMonthsAgo) return false;
          if (startDate && startDate > now) return false;
          return true;
        });
      } catch {
        // D2L unreachable
      }

      // 3. Collect assignments from all active courses
      const allAssignments: NotionAssignment[] = [];
      for (const course of activeCourses) {
        const courseAssignments = await fetchCourseAssignments(
          course.OrgUnit.Id,
          course.OrgUnit.Name,
          course.OrgUnit.Code || '',
        );
        allAssignments.push(...courseAssignments);
      }

      // 4. Sync to Notion
      try {
        const result = await syncAssignments(notionToken, args.databaseId, allAssignments);

        const total = result.created + result.updated;
        let summary: string;
        if (total === 0 && result.failed === 0) {
          summary = `Nothing to sync — no assignments found across ${activeCourses.length} course${activeCourses.length !== 1 ? 's' : ''}.`;
        } else {
          const parts: string[] = [];
          if (result.created > 0) parts.push(`${result.created} created`);
          if (result.updated > 0) parts.push(`${result.updated} updated`);
          if (result.failed > 0) parts.push(`${result.failed} failed`);
          summary = `Synced ${total} assignment${total !== 1 ? 's' : ''} (${parts.join(', ')}) across ${activeCourses.length} course${activeCourses.length !== 1 ? 's' : ''}.`;
        }

        return JSON.stringify({
          success: true,
          created: result.created,
          updated: result.updated,
          failed: result.failed,
          coursesChecked: activeCourses.length,
          summary,
        }, null, 2);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return JSON.stringify({
          success: false,
          error: msg,
        }, null, 2);
      }
    },
  },
};
