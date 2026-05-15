/**
 * Notion MCP tools — sync D2L course data to a user's Notion database.
 *
 * Creates one page per course containing assignments, grades, and announcements.
 */

import { z } from 'zod';
import { getUserId } from '../utils/userContext.js';
import { client } from '../client.js';
import { getNotionToken } from '../study/notionAuth.js';
import { syncCourses, queryAllPages, type CourseData, type AssignmentInfo, type GradeInfo, type AnnouncementInfo } from '../study/notionClient.js';
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
  Id: number;
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

  // Fetch quizzes with submission status
  try {
    const quizzesRaw = (await client.getQuizzes(orgUnitId)) as
      | { Objects: Array<{ Name: string; DueDate: string | null; IsActive: boolean; AttemptsAllowed: number | null }> }
      | Array<{ Name: string; DueDate: string | null; IsActive: boolean; AttemptsAllowed: number | null }>;
    const quizzes = Array.isArray(quizzesRaw) ? quizzesRaw : (quizzesRaw.Objects || []);
    const existingNames = new Set(courseData.assignments.map(a => a.name.toLowerCase()));

    // Also fetch quiz attempts to check submission status
    for (const quiz of quizzes) {
      if (quiz.IsActive === false) continue;
      if (!quiz.Name) continue;
      if (existingNames.has(quiz.Name.toLowerCase())) continue;

      let status: 'Not Started' | 'Submitted' | 'Graded' = 'Not Started';
      try {
        const attemptsRaw = (await client.getQuizAttempts(orgUnitId, parseInt((quiz as any).QuizId || (quiz as any).Id || '0'))) as
          | { Objects: Array<{ Attempt: { AttemptNumber: number } }> }
          | Array<{ Attempt: { AttemptNumber: number } }>;
        const attempts = Array.isArray(attemptsRaw) ? attemptsRaw : (attemptsRaw.Objects || []);
        if (attempts.length > 0) status = 'Submitted';
      } catch { /* skip attempt check */ }

      courseData.assignments.push({
        name: quiz.Name,
        dueDate: quiz.DueDate ?? null,
        maxPoints: null,
        status,
      });
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
    const d2lHost = process.env.D2L_HOST || 'learn.uwaterloo.ca';
    const raw = (await client.getNews(orgUnitId)) as RawNewsItem[];
    const news: RawNewsItem[] = Array.isArray(raw) ? raw : [];
    for (const item of news.slice(0, 5)) {
      courseData.announcements.push({
        title: item.Title,
        date: item.StartDate,
        body: item.Body?.Html ?? '',
        url: `https://${d2lHost}/d2l/le/news/${orgUnitId}/${item.Id}/view`,
      });
    }
  } catch { /* news may not be accessible */ }

  return courseData;
}

/**
 * Try to parse a human-readable date string from an outline into an ISO date.
 * Handles formats like:
 *   "Friday, May 15, 2026 at 11:55 PM"
 *   "Opens: Wednesday, June 3, 2026 at 6:55 AM Closes: Friday, June 5, 2026 at 6:55 AM"
 * For "Opens/Closes" format, returns the Closes date (deadline).
 */
function parseOutlineDate(dateStr: string | undefined): string | null {
  if (!dateStr || dateStr === 'n/a') return null;

  // If it has "Closes:", extract that date (it's the deadline)
  const closesMatch = dateStr.match(/Closes?:\s*(.+)/i);
  const target = closesMatch ? closesMatch[1].trim() : dateStr;

  // Try to parse with Date — handle "Day, Month DD, YYYY at HH:MM AM/PM"
  const cleaned = target
    .replace(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*/i, '')
    .replace(/\s+at\s+/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Outline dates are in Eastern Time — append timezone before parsing
  const withTz = cleaned.replace(/\s*(AM|PM)\s*$/i, ' $1 EDT');
  const parsed = new Date(withTz);
  if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 2020) {
    return parsed.toISOString();
  }
  // Fallback: try without timezone hint
  const fallback = new Date(cleaned);
  if (!isNaN(fallback.getTime()) && fallback.getFullYear() > 2020) {
    // Assume Eastern: add 4h (EDT offset) to treat as UTC
    return new Date(fallback.getTime() + 4 * 60 * 60 * 1000).toISOString();
  }
  return null;
}

/**
 * Clean up outline text — fix missing spaces, special chars, etc.
 */
function cleanOutlineText(text: string): string {
  return text
    .replace(/([AP]M)([A-Z])/g, '$1 $2')  // "6:55 AMCloses" → "6:55 AM Closes"
    .replace(/\s+/g, ' ')
    .trim();
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
      const codeMatch = course.code.replace(/\s+/g, '').toUpperCase().match(/([A-Z]{2,6})(\d{2,3})/);
      if (!codeMatch) continue;
      const courseCode = `${codeMatch[1]}${codeMatch[2]}`;

      const outline = await fetchCourseOutline(cookieHeader, courseCode, term);

      if (outline.assessments.length > 0) {
        // Fuzzy match: find existing assignment by prefix match or key-phrase overlap
        function findExisting(assessmentName: string): AssignmentInfo | undefined {
          const lower = assessmentName.toLowerCase();
          // Strip common prefixes for comparison: "Bonus Quiz:", "Bonus Assignment:", etc.
          const normalize = (s: string) => s.toLowerCase()
            .replace(/^(bonus\s+)?(quiz|assignment|activity):\s*/i, '')
            .replace(/\s*\([^)]*\)\s*$/, '') // remove trailing parenthetical
            .trim();
          const normalizedSearch = normalize(assessmentName);

          return course.assignments.find(a => {
            const aLower = a.name.toLowerCase();
            const aNorm = normalize(a.name);
            return aLower === lower
              || aLower.startsWith(lower)
              || lower.startsWith(aLower)
              || aNorm === normalizedSearch
              || aNorm.startsWith(normalizedSearch)
              || normalizedSearch.startsWith(aNorm);
          });
        }

        for (const assessment of outline.assessments) {
          const parsedDate = parseOutlineDate(assessment.date);
          const weightText = assessment.weight ? `Weight: ${assessment.weight}` : undefined;

          const existing = findExisting(assessment.name);
          if (existing) {
            // Enrich existing with weight and/or date from outline
            if (weightText && !existing.grade) existing.grade = weightText;
            if (parsedDate && !existing.dueDate) existing.dueDate = parsedDate;
          } else {
            // New item from outline — add it
            course.assignments.push({
              name: cleanOutlineText(assessment.name),
              dueDate: parsedDate,
              maxPoints: null,
              status: 'Not Started',
              grade: weightText,
            });
          }
        }
      }

      // Add schedule from outline
      if (outline.schedule.length > 0) {
        course.schedule = outline.schedule.map(s => ({
          week: s.week || '',
          topic: s.topic,
          readings: s.readings,
        }));
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
// "This Week" database ID per user (auto-created)
const weeklyDbIds: Map<string, string> = new Map();
// Lock to prevent concurrent syncs for the same user
const syncInProgress: Set<string> = new Set();
// Throttle: track last sync time per user (max once per hour)
const lastSyncTime: Map<string, number> = new Map();
const SYNC_THROTTLE_MS = 60 * 60 * 1000; // 1 hour

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
  const hasCode = /[A-Z]{2,6}\s*\d{2,3}/i.test(code) || /[A-Z]{2,6}\s*\d{2,3}/i.test(name);
  return hasCode;
}

/**
 * Sync upcoming tasks as rows in the SAME database with a "Due This Week" tag.
 * Uses a "Type" property set to "📌 Due Soon" to distinguish from course pages.
 * Removes old "Due Soon" entries and re-creates current ones.
 */
async function syncUpcomingTasks(
  notionToken: string,
  databaseId: string,
  courses: CourseData[],
): Promise<number> {
  const headers = { 'Authorization': `Bearer ${notionToken}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };

  // First, ensure the database has a "Type" property
  await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ properties: { 'Type': { select: {} } } }),
  });

  // Remove existing "Due Soon" tagged pages
  try {
    const existingResp = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST', headers,
      body: JSON.stringify({
        filter: { property: 'Type', select: { equals: '📌 Due Soon' } },
        page_size: 100,
      }),
    });
    if (existingResp.ok) {
      const data = await existingResp.json() as { results: Array<{ id: string }> };
      for (const page of data.results) {
        await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ archived: true }),
        });
      }
    }
  } catch { /* continue */ }

  // Collect upcoming tasks (next 10 days)
  const now = new Date();
  const tenDays = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);
  let created = 0;

  for (const course of courses) {
    const courseName = course.name.replace(/ Online - .*$/, '');
    for (const a of course.assignments) {
      if (!a.dueDate) continue;
      const due = new Date(a.dueDate);
      if (due < now || due > tenDays) continue;

      try {
        await fetch('https://api.notion.com/v1/pages', {
          method: 'POST', headers,
          body: JSON.stringify({
            parent: { database_id: databaseId },
            properties: {
              'Name': { title: [{ text: { content: `${a.name} (${courseName})` } }] },
              'Course Code': { rich_text: [{ text: { content: course.code } }] },
              'Status': { select: { name: a.status === 'Submitted' ? 'Active' : 'Active' } },
              'Next Due': { date: { start: a.dueDate } },
              'Grade': { rich_text: [{ text: { content: a.grade || '' } }] },
              'Type': { select: { name: '📌 Due Soon' } },
            },
          }),
        });
        created++;
      } catch { /* skip */ }
    }
  }

  console.error(`[NOTION] Upcoming tasks synced: ${created} items due in next 10 days`);
  return created;
}

/**
 * Remove Notion pages for courses no longer enrolled.
 * Compares by extracting the short course code (e.g. PSYCH207) from both sides.
 */
async function cleanupStalePages(
  notionToken: string,
  databaseId: string,
  activeCodes: Set<string>,
): Promise<number> {
  let archived = 0;
  try {
    const existingPages = await queryAllPages(notionToken, databaseId);
    for (const [key, pageId] of existingPages) {
      // Only check courseCode-only keys (not "code|title" compound keys)
      if (key.includes('|')) continue;
      // Extract short code from the Notion page's Course Code (e.g. "PSYCH207_081_cel_1265" → "PSYCH207")
      const shortCode = key.replace(/\s+/g, '').toUpperCase().match(/([A-Z]{2,6}\d{2,3})/)?.[1] || key;
      if (!activeCodes.has(shortCode) && !activeCodes.has(key)) {
        await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${notionToken}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived: true }),
        });
        archived++;
        console.error(`[NOTION] Archived stale page: ${key}`);
      }
    }
  } catch { /* skip */ }
  return archived;
}

/**
 * Background sync — called after tool calls to keep Notion updated.
 * Non-blocking, swallows errors. Only one sync per user at a time.
 * Throttled to max once per hour.
 */
export async function backgroundNotionSync(userId: string): Promise<void> {
  if (syncInProgress.has(userId)) return;

  // Throttle: skip if synced less than 1 hour ago
  const lastSync = lastSyncTime.get(userId) || 0;
  if (Date.now() - lastSync < SYNC_THROTTLE_MS) return;

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

    // Sync course pages
    await syncCourses(notionToken, databaseId, courses);

    // Sync "Due Soon" tasks
    try {
      await syncUpcomingTasks(notionToken, databaseId, courses);
    } catch { /* skip */ }

    // Cleanup stale pages
    const activeCodes = new Set(courses.map(c => {
      const m = c.code.replace(/\s+/g, '').toUpperCase().match(/([A-Z]{2,6}\d{2,3})/);
      return m ? m[1] : c.code;
    }));
    await cleanupStalePages(notionToken, databaseId, activeCodes);

    lastSyncTime.set(userId, Date.now());
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

        // 5. Sync "Due Soon" tasks as rows in the same database
        let upcomingCount = 0;
        try {
          upcomingCount = await syncUpcomingTasks(notionToken, args.databaseId, courses);
        } catch { /* skip */ }

        // 6. Cleanup stale pages
        const activeCodes = new Set(courses.map(c => {
          const m = c.code.replace(/\s+/g, '').toUpperCase().match(/([A-Z]{2,6}\d{2,3})/);
          return m ? m[1] : c.code;
        }));
        const archived = await cleanupStalePages(notionToken, args.databaseId, activeCodes);

        lastSyncTime.set(userId!, Date.now());

        const total = result.created + result.updated;
        const parts: string[] = [];
        if (result.created > 0) parts.push(`${result.created} created`);
        if (result.updated > 0) parts.push(`${result.updated} updated`);
        if (result.failed > 0) parts.push(`${result.failed} failed`);
        if (archived > 0) parts.push(`${archived} archived`);

        const summary = total === 0 && result.failed === 0
          ? `No courses to sync.`
          : `Synced ${total} course page${total !== 1 ? 's' : ''} (${parts.join(', ')}).`;

        return JSON.stringify({
          success: true,
          ...result,
          archived,
          upcomingTasks: upcomingCount,
          coursesChecked: activeCourses.length,
          summary,
          autoSyncEnabled: true,
          message: `Notion synced. ${upcomingCount} "Due Soon" tasks added (filter by Type: 📌 Due Soon for weekly view). Background sync runs max once/hour.`,
        }, null, 2);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return JSON.stringify({ success: false, error: msg }, null, 2);
      }
    },
  },
};
