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
import { fetchCourseOutline, getCurrentTerm, type Assessment } from '../study/outlineClient.js';
import { getOrRefreshOutlineCookies } from '../study/outlineAuth.js';

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

  // Fetch assignments (dropbox)
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

  // Fetch quizzes
  try {
    const quizzes = (await client.getQuizzes(orgUnitId)) as Array<{
      Name: string;
      DueDate: string | null;
      IsActive: boolean;
    }>;
    if (Array.isArray(quizzes)) {
      const existingNames = new Set(courseData.assignments.map(a => a.name.toLowerCase()));
      for (const quiz of quizzes) {
        if (!quiz.IsActive) continue;
        // Don't duplicate if already in dropbox
        if (existingNames.has(quiz.Name.toLowerCase())) continue;
        courseData.assignments.push({
          name: quiz.Name,
          dueDate: quiz.DueDate,
          maxPoints: null,
          status: 'Not Started',
        });
      }
    }
  } catch { /* quizzes may not be accessible */ }

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

/**
 * Enrich course data with outline assessments (weights, due dates from syllabus).
 * Merges outline assessments into existing assignments or adds new ones.
 */
async function enrichWithOutline(courses: CourseData[], userId: string): Promise<void> {
  let cookieHeader: string;
  try {
    cookieHeader = await getOrRefreshOutlineCookies(userId);
  } catch {
    return; // outline not connected, skip silently
  }

  const term = getCurrentTerm();

  for (const course of courses) {
    try {
      // Extract course code from D2L code (e.g. "PSYCH207_081_cel_1265" → "PSYCH207")
      const codeMatch = course.code.replace(/\s+/g, '').toUpperCase().match(/([A-Z]{2,6})(\d{3})/);
      if (!codeMatch) continue;
      const courseCode = `${codeMatch[1]}${codeMatch[2]}`;

      const outline = await fetchCourseOutline(cookieHeader, courseCode, term);

      if (outline.assessments.length > 0) {
        // Merge outline assessments: add any not already in assignments list
        const existingNames = new Set(course.assignments.map(a => a.name.toLowerCase()));

        for (const assessment of outline.assessments) {
          if (!existingNames.has(assessment.name.toLowerCase())) {
            course.assignments.push({
              name: assessment.name,
              dueDate: assessment.date ?? null,
              maxPoints: null,
              status: 'Not Started',
              grade: assessment.weight ? `Weight: ${assessment.weight}` : undefined,
            });
          } else {
            // Enrich existing assignment with weight info
            const existing = course.assignments.find(
              a => a.name.toLowerCase() === assessment.name.toLowerCase()
            );
            if (existing && assessment.weight && !existing.grade) {
              existing.grade = `Weight: ${assessment.weight}`;
            }
          }
        }
      }

      // Add instructor info to announcements if not already there
      if (outline.instructors.length > 0 && course.announcements.length === 0) {
        const instructorList = outline.instructors
          .map(i => `${i.name}${i.email ? ` (${i.email})` : ''}`)
          .join(', ');
        course.announcements.push({
          title: 'Instructors',
          date: new Date().toISOString(),
          body: instructorList,
        });
      }
    } catch {
      // Outline not available for this course, skip
    }
  }
}

// Stored database ID per user (in-memory cache for auto-sync)
const userDatabaseIds: Map<string, string> = new Map();
// Lock to prevent concurrent syncs for the same user
const syncInProgress: Set<string> = new Set();

/**
 * Non-academic course patterns to exclude from Notion sync.
 * These are community/administrative courses, not real classes.
 */
const EXCLUDED_PATTERNS = [
  /^uwaterloo.ses$/i,
  /co-?op community/i,
  /residence/i,
  /^cfe[_\s]/i,
  /orientation/i,
  /wellness/i,
  /student.?life/i,
  /academic.?integrity/i,
];

function isAcademicCourse(enrollment: RawEnrollment): boolean {
  const name = enrollment.OrgUnit.Name;
  const code = enrollment.OrgUnit.Code || '';
  // Must be a Course Offering with active access
  if (enrollment.OrgUnit?.Type?.Code !== 'Course Offering') return false;
  if (!enrollment.Access?.IsActive || !enrollment.Access?.CanAccess) return false;
  // Exclude non-academic courses
  if (EXCLUDED_PATTERNS.some(p => p.test(name) || p.test(code))) return false;
  // Must have a recognizable course code pattern (letters + digits)
  const hasCode = /[A-Z]{2,6}\s*\d{3}/i.test(code) || /[A-Z]{2,6}\s*\d{3}/i.test(name);
  return hasCode;
}

/**
 * Background sync — called after tool calls to keep Notion updated.
 * Non-blocking, swallows errors. Only one sync per user at a time.
 */
export async function backgroundNotionSync(userId: string): Promise<void> {
  if (syncInProgress.has(userId)) return; // already running
  syncInProgress.add(userId);

  try {
    const notionToken = await getNotionToken(userId);
    if (!notionToken) return;

    const databaseId = userDatabaseIds.get(userId);
    if (!databaseId) return;

    // Fetch enrollments — only real academic courses
    const enrollmentsRaw = (await client.getMyEnrollments()) as { Items: RawEnrollment[] };
    const activeCourses = (enrollmentsRaw.Items || []).filter(isAcademicCourse);

    // Fetch course data in parallel (faster)
    const courses = await Promise.all(
      activeCourses.map(e => fetchCourseData(e.OrgUnit.Id, e.OrgUnit.Name, e.OrgUnit.Code || ''))
    );

    // Enrich with outline data
    await enrichWithOutline(courses, userId);

    await syncCourses(notionToken, databaseId, courses);
    console.error(`[NOTION] Background sync complete: ${courses.length} courses`);
  } catch (e) {
    console.error(`[NOTION] Background sync error: ${e instanceof Error ? e.message : e}`);
  } finally {
    syncInProgress.delete(userId);
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

      // 2. Fetch active academic enrollments (skip admin/community courses)
      let activeCourses: RawEnrollment[] = [];
      try {
        const enrollmentsRaw = (await client.getMyEnrollments()) as { Items: RawEnrollment[] };
        activeCourses = (enrollmentsRaw.Items || []).filter(isAcademicCourse);
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: `Failed to fetch D2L courses: ${e instanceof Error ? e.message : e}`,
        }, null, 2);
      }

      // 3. Fetch full course data in parallel
      const courses = await Promise.all(
        activeCourses.map(e => fetchCourseData(e.OrgUnit.Id, e.OrgUnit.Name, e.OrgUnit.Code || ''))
      );

      // 3b. Enrich with outline data (assessments, weights, instructors)
      if (userId) {
        await enrichWithOutline(courses, userId);
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
