/**
 * Notion MCP tools — sync D2L course data to a user's Notion database.
 *
 * Creates one page per course containing assignments, grades, and announcements.
 */

import { z } from 'zod';
import { getUserId } from '../utils/userContext.js';
import { client } from '../client.js';
import { getNotionToken } from '../study/notionAuth.js';
import { syncCourses, type CourseData, type AssignmentInfo, type GradeInfo, type AnnouncementInfo } from '../study/notionClient.js';

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

interface RawGradeValue {
  GradeObjectName: string;
  PointsNumerator: number | null;
  PointsDenominator: number | null;
  WeightedNumerator: number | null;
  WeightedDenominator: number | null;
}

interface RawNewsItem {
  Title: string;
  StartDate: string;
  Body: { Html: string } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CONNECT_HINT =
  'Connect Notion via the Horizon dashboard (/onboard) — click "Connect" next to Notion, ' +
  'then authorise the integration and paste the database ID shown on the page.';

async function fetchCourseData(orgUnitId: number, name: string, code: string): Promise<CourseData> {
  const courseData: CourseData = {
    orgUnitId,
    name,
    code,
    isActive: true,
    assignments: [],
    grades: [],
    announcements: [],
  };

  // Fetch assignments
  try {
    const raw = (await client.getDropboxFolders(orgUnitId)) as RawAssignment[];
    const folders: RawAssignment[] = Array.isArray(raw) ? raw : [];
    for (const folder of folders) {
      courseData.assignments.push({
        name: folder.Name,
        dueDate: folder.DueDate,
        maxPoints: folder.Assessment?.ScoreDenominator ?? null,
        status: 'Not Started',
      });
    }
  } catch { /* course may not expose dropbox */ }

  // Fetch grades
  try {
    const raw = (await client.getMyGradeValues(orgUnitId)) as RawGradeValue[];
    const grades: RawGradeValue[] = Array.isArray(raw) ? raw : [];
    for (const g of grades) {
      courseData.grades.push({
        name: g.GradeObjectName,
        pointsNumerator: g.PointsNumerator,
        pointsDenominator: g.PointsDenominator,
        weightedNumerator: g.WeightedNumerator,
        weightedDenominator: g.WeightedDenominator,
      });
    }
    // Mark assignments as graded if we have a matching grade
    for (const a of courseData.assignments) {
      const grade = courseData.grades.find(g => g.name === a.name);
      if (grade && grade.pointsNumerator !== null) {
        a.status = 'Graded';
        a.grade = `${grade.pointsNumerator}/${grade.pointsDenominator}`;
      }
    }
  } catch { /* grades may not be accessible */ }

  // Fetch announcements
  try {
    const raw = (await client.getNews(orgUnitId)) as RawNewsItem[];
    const news: RawNewsItem[] = Array.isArray(raw) ? raw : [];
    for (const item of news.slice(0, 5)) {
      courseData.announcements.push({
        title: item.Title,
        date: item.StartDate,
        body: item.Body?.Html ?? '',
      });
    }
  } catch { /* news may not be accessible */ }

  return courseData;
}

// Stored database ID per user (in-memory cache for auto-sync)
const userDatabaseIds: Map<string, string> = new Map();

/**
 * Background sync — called after tool calls to keep Notion updated.
 * Non-blocking, swallows errors.
 */
export async function backgroundNotionSync(userId: string): Promise<void> {
  try {
    const notionToken = await getNotionToken(userId);
    if (!notionToken) return;

    const databaseId = userDatabaseIds.get(userId);
    if (!databaseId) return;

    // Fetch enrollments
    const enrollmentsRaw = (await client.getMyEnrollments()) as { Items: RawEnrollment[] };
    const now = new Date();
    const sixMonthsAgo = new Date(now.getTime() - 6 * 30 * 24 * 60 * 60 * 1000);
    const activeCourses = (enrollmentsRaw.Items || []).filter((e) => {
      if (e.OrgUnit?.Type?.Code !== 'Course Offering') return false;
      if (!e.Access?.IsActive || !e.Access?.CanAccess) return false;
      const endDate = e.Access.EndDate ? new Date(e.Access.EndDate) : null;
      if (endDate && endDate < sixMonthsAgo) return false;
      return true;
    });

    const courses: CourseData[] = [];
    for (const enrollment of activeCourses) {
      const course = await fetchCourseData(
        enrollment.OrgUnit.Id,
        enrollment.OrgUnit.Name,
        enrollment.OrgUnit.Code || '',
      );
      courses.push(course);
    }

    await syncCourses(notionToken, databaseId, courses);
    console.error(`[NOTION] Background sync complete: ${courses.length} courses`);
  } catch (e) {
    console.error(`[NOTION] Background sync error: ${e instanceof Error ? e.message : e}`);
  }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const notionTools = {
  sync_to_notion: {
    description:
      `Sync all your D2L course data into a Notion database. ` +
      `Creates one page per course containing assignments (with due dates & grades), ` +
      `grade breakdown, and recent announcements. Updates existing pages on re-sync. ` +
      `After the first sync, Notion auto-updates in the background on every tool call. ` +
      `Requires Notion to be connected via the dashboard (/onboard). ` +
      `Pass the Notion database ID (from the database URL).`,
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

      // Store database ID for auto-sync
      if (userId) userDatabaseIds.set(userId, args.databaseId);

      // 2. Fetch active enrollments
      let activeCourses: RawEnrollment[] = [];
      try {
        const enrollmentsRaw = (await client.getMyEnrollments()) as { Items: RawEnrollment[] };
        const now = new Date();
        const sixMonthsAgo = new Date(now.getTime() - 6 * 30 * 24 * 60 * 60 * 1000);
        activeCourses = (enrollmentsRaw.Items || []).filter((e) => {
          if (e.OrgUnit?.Type?.Code !== 'Course Offering') return false;
          if (!e.Access?.IsActive || !e.Access?.CanAccess) return false;
          const endDate = e.Access.EndDate ? new Date(e.Access.EndDate) : null;
          if (endDate && endDate < sixMonthsAgo) return false;
          return true;
        });
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: `Failed to fetch D2L courses: ${e instanceof Error ? e.message : e}`,
        }, null, 2);
      }

      // 3. Fetch full course data for each
      const courses: CourseData[] = [];
      for (const enrollment of activeCourses) {
        const course = await fetchCourseData(
          enrollment.OrgUnit.Id,
          enrollment.OrgUnit.Name,
          enrollment.OrgUnit.Code || '',
        );
        courses.push(course);
      }

      // 4. Sync to Notion
      try {
        const result = await syncCourses(notionToken, args.databaseId, courses);

        const total = result.created + result.updated;
        const parts: string[] = [];
        if (result.created > 0) parts.push(`${result.created} created`);
        if (result.updated > 0) parts.push(`${result.updated} updated`);
        if (result.failed > 0) parts.push(`${result.failed} failed`);

        const summary = total === 0 && result.failed === 0
          ? `No courses to sync.`
          : `Synced ${total} course page${total !== 1 ? 's' : ''} (${parts.join(', ')}).`;

        return JSON.stringify({
          success: true,
          ...result,
          coursesChecked: activeCourses.length,
          summary,
          autoSyncEnabled: true,
          message: 'Notion will now auto-sync in the background on subsequent tool calls.',
        }, null, 2);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return JSON.stringify({ success: false, error: msg }, null, 2);
      }
    },
  },
};
