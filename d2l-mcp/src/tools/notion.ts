/**
 * Notion MCP tools — sync D2L course data to a user's Notion database.
 *
 * Creates one page per course containing assignments, grades, and announcements.
 */

import { z } from 'zod';
import { getUserId, runWithUserId } from '../utils/userContext.js';
import { client } from '../client.js';
import { classifyDateEvent, DateType, Confidence } from '../utils/dateEvent.js';
import { getNotionToken } from '../study/notionAuth.js';
import { syncCourses, queryAllPages, type CourseData, type AssignmentInfo, type GradeInfo, type AnnouncementInfo } from '../study/notionClient.js';
import { fetchCourseOutline, getCurrentTerm, type Assessment } from '../study/outlineClient.js';
import { getOrRefreshOutlineCookies } from '../study/outlineAuth.js';
import { loadWebsiteAssessmentsForCourse } from '../study/src/courseWebsite/store.js';
import { getSourceConfig } from '../study/src/courseWebsite/sources.js';
import { zonedWallTimeToUtcIso } from '../study/src/courseWebsite/timezone.js';

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

interface RawCalendarEvent {
  Title: string;
  Description?: string | null;
  EndDateTime?: string | null;
  StartDateTime?: string | null;
  CalendarEventViewUrl?: string;
  OrgUnitName?: string;
  // The strongest classification signal: D2L links assessment calendar events to
  // their originating tool (e.g. "…Dropbox", "…Quiz"). Purely-scheduled events
  // (lectures/tutorials/office hours) have no assessment entity.
  AssociatedEntity?: {
    AssociatedEntityType?: string;
    AssociatedEntityId?: number;
    Link?: string;
  } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CONNECT_HINT =
  'Connect Notion via the Horizon dashboard (/onboard) — click "Connect" next to Notion, ' +
  'then authorise the integration and paste the database ID shown on the page.';

/**
 * Extract a stable course code (SUBJECT + NUMBER + optional single course-letter
 * suffix) from a messy D2L code or org-unit name.
 *
 * D2L codes glue a section/term token onto the code with a delimiter, e.g.
 * "1261_CS135_LEC001", "ECE222_W26", "PSYCH207_081_cel_1265", "CS 135 001". We must
 * NOT let the leading letter of that token (LEC/LAB/W…) be mistaken for a course
 * suffix, while still keeping genuine suffix variants distinct (PHYS121 != PHYS121L,
 * CS241 != CS241E). So we split on delimiters into tokens first, rejoin a bare
 * subject with its following number ("CS" + "135"), and take the first token shaped
 * like a course code — its optional trailing letter is only ever the code's own,
 * because the section/term token is a separate token.
 */
function normalizeCourseCodeExact(input: string): string | null {
  if (!input) return null;
  const rawTokens = input.toUpperCase().split(/[\s_-]+/).filter(Boolean);
  const tokens: string[] = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const t = rawTokens[i];
    const next = rawTokens[i + 1];
    // Rejoin a space/delimiter-separated subject and number ("CS" + "135" → "CS135").
    if (/^[A-Z]{2,6}$/.test(t) && next && /^\d{2,3}[A-Z]?$/.test(next)) {
      tokens.push(t + next);
      i++;
    } else {
      tokens.push(t);
    }
  }
  for (const t of tokens) {
    const match = t.match(/^([A-Z]{2,6}\d{2,3}[A-Z]?)/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Decide whether a D2L calendar event is a real assessment/deadline (INCLUDE) vs a
 * scheduled meeting or generic course event (EXCLUDE). Reuses the repository's
 * existing classification logic (classifyDateEvent) and prefers strong metadata
 * (AssociatedEntityType) over fragile title keywords.
 */
function isAssessmentCalendarEvent(event: RawCalendarEvent): boolean {
  const entityType = event.AssociatedEntity?.AssociatedEntityType || '';
  // Strong metadata: a Dropbox (assignment) or Quiz association is authoritative.
  if (/Dropbox|Assignment/i.test(entityType)) return true;
  if (/Quiz/i.test(entityType)) return true;
  // Otherwise fall back to title/description classification.
  const { dateType, confidence } = classifyDateEvent(
    event.Title || '',
    event.Description || '',
    entityType || null,
  );
  // Scheduled meetings (lecture/tutorial/lab/office hours/…) are never assessments.
  if (dateType === DateType.LECTURE) return false;
  // Deadlines and exams/quizzes are assessments when classified with real signal.
  if (dateType === DateType.DUE || dateType === DateType.EXAM) {
    return confidence !== Confidence.LOW;
  }
  // Anything else (UNKNOWN, opens/closes-only, feedback) is not ingested as work.
  return false;
}

function parseCalendarEventDate(event: {
  dueDateIso?: string | null;
  EndDateTime?: string | null;
  StartDateTime?: string | null;
  dueDate?: string | null;
}): string | null {
  const candidates = [event.dueDateIso, event.EndDateTime, event.StartDateTime, event.dueDate];
  for (const candidate of candidates) {
    if (!candidate || !candidate.trim()) continue;
    const parsed = new Date(candidate);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return null;
}

function mergeAssignments(assignments: AssignmentInfo[], incoming: AssignmentInfo): void {
  const key = incoming.name.trim().toLowerCase();
  const existing = assignments.find((a) => a.name.trim().toLowerCase() === key);
  if (!existing) {
    assignments.push(incoming);
    return;
  }
  if (!existing.dueDate && incoming.dueDate) existing.dueDate = incoming.dueDate;
  if (existing.maxPoints === null && incoming.maxPoints !== null) existing.maxPoints = incoming.maxPoints;
  if ((!existing.grade || existing.grade.length === 0) && incoming.grade) existing.grade = incoming.grade;
  if (!existing.url && incoming.url) existing.url = incoming.url;
  if (existing.status === 'Not Started' && incoming.status !== 'Not Started') existing.status = incoming.status;
}

async function fetchCourseData(orgUnitId: number, name: string, code: string): Promise<CourseData> {
  let assignmentSourceFailures = 0;
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
  const d2lHost = process.env.D2L_HOST || 'learn.uwaterloo.ca';
  try {
    const raw = (await client.getDropboxFolders(orgUnitId)) as RawAssignment[];
    const folders: RawAssignment[] = Array.isArray(raw) ? raw : [];
    for (const folder of folders) {
      mergeAssignments(courseData.assignments, {
        name: folder.Name,
        dueDate: folder.DueDate,
        maxPoints: folder.Assessment?.ScoreDenominator ?? null,
        status: 'Not Started',
        url: `https://${d2lHost}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${folder.Id}&grpid=0&isprv=0&bp=0&ou=${orgUnitId}`,
      });
    }
  } catch {
    assignmentSourceFailures++;
  }

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

      const quizId = (quiz as any).QuizId || (quiz as any).Id || '0';
      mergeAssignments(courseData.assignments, {
        name: quiz.Name,
        dueDate: quiz.DueDate ?? null,
        maxPoints: null,
        status,
        url: `https://${d2lHost}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${quizId}&ou=${orgUnitId}`,
      });
    }
  } catch {
    assignmentSourceFailures++;
  }

  // Fetch calendar events and merge as additional assignment sources.
  try {
    const now = new Date();
    const startDateTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const endDateTime = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();
    const calendarRaw = (await client.getMyCalendarEvents(orgUnitId, startDateTime, endDateTime)) as
      | { Objects: RawCalendarEvent[] }
      | RawCalendarEvent[];
    const events = Array.isArray(calendarRaw) ? calendarRaw : (calendarRaw.Objects || []);
    const targetCode = normalizeCourseCodeExact(code) ?? normalizeCourseCodeExact(name);
    for (const event of events) {
      if (!event.Title) continue;
      const eventCode = normalizeCourseCodeExact(event.OrgUnitName || '');
      if (targetCode && eventCode && eventCode !== targetCode) continue;
      // Only ingest assessment/deadline-like events — never lectures, tutorials,
      // office hours, or bare lab/scheduled meetings.
      if (!isAssessmentCalendarEvent(event)) continue;
      mergeAssignments(courseData.assignments, {
        name: event.Title.trim(),
        dueDate: parseCalendarEventDate(event),
        maxPoints: null,
        status: 'Not Started',
        url: event.CalendarEventViewUrl || undefined,
      });
    }
  } catch {
    assignmentSourceFailures++;
  }

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

  if (courseData.assignments.length === 0 || assignmentSourceFailures > 0) {
    courseData.syncMetadata = {
      preserveExistingAssignments: courseData.assignments.length === 0,
      assignmentSourceFailures,
    };
  }

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

const OUTLINE_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parse a day-first outline date like "Tue 22 Sep at 9pm" or "Tue 6 Oct 6:00 PM"
 * into a UTC ISO instant (America/Toronto wall clock). Returns null if no time.
 */
export function parseOutlineSegmentDate(text: string, year: number): string | null {
  const md = text.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i);
  if (!md) return null;
  const day = Number(md[1]);
  const mon = OUTLINE_MONTHS[md[2].slice(0, 3).toLowerCase()];
  const mt = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b/i);
  if (!mt) return null;
  let h = Number(mt[1]);
  const mi = mt[2] ? Number(mt[2]) : 0;
  const ap = mt[3].toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (!mon || day < 1 || day > 31 || h > 23) return null;
  return zonedWallTimeToUtcIso({ year, month: mon, day, hour: h, minute: mi }, 'America/Toronto');
}

interface OutlineAssessmentLike { name: string; date?: string; weight?: string }

/**
 * Expand a combined outline assessment row into discrete items. UW outlines often
 * pack several assignments into one row whose date field is
 * "A01: Tue 22 Sep at 9pm A02: Tue 29 Sep at 9pm …"; we split those into A01, A02, …
 * (and P01, … for projects) so each appears discretely with its own date. Also
 * normalizes "Asn#0"/"Assignment 0"-style names to A00. Rows without the pattern are
 * returned unchanged.
 */
export function expandOutlineAssessments(assessments: OutlineAssessmentLike[]): OutlineAssessmentLike[] {
  const out: OutlineAssessmentLike[] = [];
  for (const a of assessments) {
    const date = a.date || '';
    const segs = [...date.matchAll(/\b([AP])(\d{1,2})\s*:\s*([\s\S]*?)(?=\b[AP]\d{1,2}\s*:|$)/g)];
    if (segs.length >= 2) {
      for (const s of segs) {
        const letter = s[1].toUpperCase();
        const num = String(parseInt(s[2], 10)).padStart(2, '0');
        out.push({ name: `${letter === 'P' ? 'P' : 'A'}${num}`, date: s[3].trim(), weight: a.weight });
      }
      continue;
    }
    const asn = a.name.match(/\bAsn\s*#?\s*(\d+)/i) || a.name.match(/\bassignment\s+(\d+)\b/i);
    out.push(asn ? { ...a, name: `A${String(parseInt(asn[1], 10)).padStart(2, '0')}` } : a);
  }
  return out;
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
      const courseCode = normalizeCourseCodeExact(course.code) ?? normalizeCourseCodeExact(course.name);
      if (!courseCode) continue;

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

        const outlineYear = 2000 + Number(term.slice(1, 3));
        for (const assessment of expandOutlineAssessments(outline.assessments)) {
          const parsedDate = parseOutlineDate(assessment.date) ?? parseOutlineSegmentDate(assessment.date || '', outlineYear);
          const weightText = assessment.weight ? `Weight: ${assessment.weight}` : undefined;

          const existing = findExisting(assessment.name);
          if (existing) {
            // Enrich existing with weight and/or date from outline
            if (weightText && !existing.grade) existing.grade = weightText;
            if (parsedDate && !existing.dueDate) existing.dueDate = parsedDate;
          } else {
            // New item from outline — add it
            mergeAssignments(course.assignments, {
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

// A cleaned assessment name that still embeds a date token (e.g. "Project … 17 Nov")
// is a malformed parse we refuse to surface — the outline provides the authoritative
// row (P01) and we must not duplicate it under a garbled title.
const WEBSITE_NAME_DATE_TOKEN = /\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

/**
 * Enrich course data with assessments parsed from the course website (course_website_items),
 * so both D2L/outline AND the public course site act as sources of truth. Website-derived
 * due dates are authoritative for a matched assessment, but this NEVER downgrades an
 * authoritative submitted/graded/overdue status (we cannot observe submission from a public
 * site). Runs after enrichWithOutline so outline-only items (e.g. SE 212 A00/A01) are present
 * for matching, and website-only items (e.g. CS 241 A1–A8) get added.
 */
export async function enrichWithCourseWebsite(courses: CourseData[], userId: string): Promise<void> {
  const term = getCurrentTerm();
  for (const course of courses) {
    const courseCode = normalizeCourseCodeExact(course.code) ?? normalizeCourseCodeExact(course.name);
    if (!courseCode) continue;
    if (!getSourceConfig(courseCode, term)) continue; // only courses with a configured website source
    let items: Awaited<ReturnType<typeof loadWebsiteAssessmentsForCourse>>;
    try {
      items = await loadWebsiteAssessmentsForCourse(userId, courseCode, term);
    } catch {
      continue; // website data unavailable for this course, skip silently
    }
    for (const it of items) {
      const name = it.name.trim();
      if (!name || WEBSITE_NAME_DATE_TOKEN.test(name)) continue;
      const key = name.toLowerCase();
      const existing = course.assignments.find((a) => a.name.trim().toLowerCase() === key);
      if (existing) {
        // Website date is authoritative for a matched item; status is never touched here.
        if (it.dueAt) existing.dueDate = it.dueAt;
        if (!existing.url && it.url) existing.url = it.url;
      } else {
        mergeAssignments(course.assignments, {
          name,
          dueDate: it.dueAt,
          maxPoints: null,
          status: 'Not Started',
          url: it.url ?? undefined,
        });
      }
    }
  }
}

/**
 * Recompute the assignment-preservation decision AFTER all sources (D2L + outline +
 * course website) have been merged.
 *
 * fetchCourseData sets preserveExistingAssignments from the D2L-only assignment count,
 * which runs BEFORE outline/website enrichment. Without this pass, a course whose
 * assignments come solely from the outline or the course website (e.g. CS 241, which
 * has no D2L dropbox folders) would be flagged "preserve" and its managed body would
 * never be written — the website/outline items would silently never reach Notion.
 *
 * We only RELAX the flag: if the final merged set is non-empty AND no D2L source hard-
 * failed (threw), we clear preserve so the body is written. An empty final set still
 * preserves (nothing new to show), and a genuine source failure still preserves (a
 * failed D2L fetch could drop previously-synced items on a full rewrite).
 */
export function finalizeAssignmentPreservation(courses: CourseData[]): void {
  for (const course of courses) {
    const failures = course.syncMetadata?.assignmentSourceFailures ?? 0;
    const empty = course.assignments.length === 0;
    if (empty || failures > 0) {
      course.syncMetadata = { preserveExistingAssignments: empty, assignmentSourceFailures: failures };
    } else {
      delete course.syncMetadata; // confident, non-empty merged set — allow body rewrite
    }
  }
}

/**
 * Mark past-due assignments as Overdue (if not already submitted/graded).
 * Should run AFTER all data sources (D2L + outline) have been merged.
 */
function markOverdueAssignments(courses: CourseData[]): void {
  const now = new Date();
  for (const course of courses) {
    for (const a of course.assignments) {
      if (a.dueDate && a.status === 'Not Started') {
        if (new Date(a.dueDate) < now) {
          a.status = 'Overdue';
        }
      }
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
/**
 * Whether the current sync is AUTHORITATIVE enough to run the destructive Due Soon
 * reconciliation (which archives all existing generated reminders and rebuilds them
 * from the in-memory assignment list).
 *
 * It is authoritative ONLY when enrollment returned at least one verified active
 * academic course AND no course carries preservation metadata (an empty source or a
 * partial source failure). On a non-authoritative sync we must NOT archive existing
 * Due Soon rows, because rebuilding from a partial/empty snapshot would delete valid
 * reminders that came from the failed/empty source.
 */
function isAuthoritativeForDueSoon(activeCourseCount: number, courses: CourseData[]): boolean {
  if (activeCourseCount === 0) return false;
  return !courses.some(c =>
    c.syncMetadata?.preserveExistingAssignments === true ||
    (c.syncMetadata?.assignmentSourceFailures ?? 0) > 0,
  );
}

async function syncUpcomingTasks(
  notionToken: string,
  databaseId: string,
  courses: CourseData[],
): Promise<number> {
  const headers = { 'Authorization': `Bearer ${notionToken}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };

  // First, ensure the database has a "Type" property. Check the response.
  const ensureResp = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ properties: { 'Type': { select: {} } } }),
  });
  if (!ensureResp.ok) {
    throw new Error(`Notion ensure Due Soon "Type" property failed (${ensureResp.status})`);
  }

  // Remove existing "Due Soon" tagged rows. Every mutation response is checked and
  // surfaced — this reconciliation only runs on an authoritative sync (see caller).
  const existingResp = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
    method: 'POST', headers,
    body: JSON.stringify({
      filter: { property: 'Type', select: { equals: '📌 Due Soon' } },
      page_size: 100,
    }),
  });
  if (!existingResp.ok) {
    throw new Error(`Notion Due Soon query failed (${existingResp.status})`);
  }
  const data = await existingResp.json() as { results: Array<{ id: string }> };
  for (const page of data.results) {
    const archiveResp = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ archived: true }),
    });
    if (!archiveResp.ok) {
      throw new Error(`Notion archive Due Soon row ${page.id} failed (${archiveResp.status})`);
    }
  }

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

      const createResp = await fetch('https://api.notion.com/v1/pages', {
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
      if (!createResp.ok) {
        throw new Error(`Notion create Due Soon row for "${a.name}" failed (${createResp.status})`);
      }
      created++;
    }
  }

  console.error(`[NOTION] Upcoming tasks synced: ${created} items due in next 10 days`);
  return created;
}

/**
 * Remove Notion pages for courses no longer enrolled.
 * Compares by extracting the short course code (e.g. PSYCH207) from both sides.
 */
/**
 * Build the set of "active" course identifiers used to decide which Notion pages
 * are stale. Includes BOTH the normalized code and the raw uppercased code for each
 * course so a stored page key matches whether it was written as the raw D2L code or
 * a normalized one — preventing a live course's page from being wrongly archived.
 */
function buildActiveCodes(courses: CourseData[]): Set<string> {
  const codes = new Set<string>();
  for (const c of courses) {
    const norm = normalizeCourseCodeExact(c.code) ?? normalizeCourseCodeExact(c.name);
    if (norm) codes.add(norm);
    if (c.code) codes.add(c.code.toUpperCase());
  }
  return codes;
}

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
      const normalizedCode = normalizeCourseCodeExact(key) ?? key;
      if (!activeCodes.has(normalizedCode) && !activeCodes.has(key) && !activeCodes.has(key.toUpperCase())) {
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
  // Fail CLOSED: background sync (which writes to a user's Notion) runs ONLY when
  // explicitly enabled. An unset/empty/any-other value means DISABLED so a default
  // or misconfigured deployment never performs background writes. Manual
  // sync_to_notion is intentionally NOT gated by this and remains available.
  if (process.env.BACKGROUND_NOTION_SYNC_ENABLED !== 'true') return;
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

    // Bind the D2L identity to this userId for the whole sync so cross-user
    // isolation cannot break if this is ever called outside a request's async
    // context (the D2L `client` proxy resolves the user from AsyncLocalStorage).
    await runWithUserId(userId, async () => {
      // Fetch enrollments — only real academic courses
      const enrollmentsRaw = (await client.getMyEnrollments()) as { Items: RawEnrollment[] };
      const activeCourses = (enrollmentsRaw.Items || []).filter(isAcademicCourse);

      // Fetch course data in parallel (faster)
      const courses = await Promise.all(
        activeCourses.map(e => fetchCourseData(e.OrgUnit.Id, e.OrgUnit.Name, e.OrgUnit.Code || ''))
      );

      // Enrich with outline data, then course-website data (both are sources of truth)
      await enrichWithOutline(courses, userId);
      await enrichWithCourseWebsite(courses, userId);
      markOverdueAssignments(courses);
      finalizeAssignmentPreservation(courses);

      // Sync course pages
      await syncCourses(notionToken, databaseId, courses);

      // Reconcile "Due Soon" reminder rows — but ONLY on an authoritative sync.
      // Due Soon reconciliation is destructive (it archives existing generated rows
      // and rebuilds from the in-memory list). On an empty/non-authoritative
      // enrollment or any course with preservation metadata (empty/failed source),
      // we skip it entirely so valid existing reminders are never archived.
      if (isAuthoritativeForDueSoon(activeCourses.length, courses)) {
        try {
          await syncUpcomingTasks(notionToken, databaseId, courses);
        } catch (e) {
          console.error(`[NOTION] Due Soon reconciliation failed (preserved existing rows): ${e instanceof Error ? e.message : e}`);
        }
      } else {
        console.error('[NOTION] Skipping Due Soon reconciliation: non-authoritative/partial sync — existing reminders preserved.');
      }

      // Cleanup stale pages — but ONLY when we have a verified, non-empty active
      // course list. A successful-but-empty getMyEnrollments() is NOT authoritative
      // for destructive archival: treating it as "no courses" would archive every
      // page. When there are zero verified active academic courses we skip cleanup.
      if (activeCourses.length > 0) {
        await cleanupStalePages(notionToken, databaseId, buildActiveCodes(courses));
      } else {
        console.error('[NOTION] Skipping stale-page cleanup: no verified active courses (non-authoritative empty enrollment).');
      }

      lastSyncTime.set(userId, Date.now());
      console.error(`[NOTION] Background sync complete: ${courses.length} courses`);
    });
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

      // 3b. Enrich with outline data (assessments, weights, instructors) + course website
      if (userId) {
        await enrichWithOutline(courses, userId);
        await enrichWithCourseWebsite(courses, userId);
      }
      markOverdueAssignments(courses);
      finalizeAssignmentPreservation(courses);

      // 4. Sync to Notion
      try {
        const result = await syncCourses(notionToken, args.databaseId, courses);

        // 5. Reconcile "Due Soon" reminder rows — only on an authoritative sync.
        // Destructive reconciliation is skipped on empty/non-authoritative
        // enrollment or any course with preservation metadata, so valid existing
        // reminders are never archived from a partial/empty snapshot.
        let upcomingCount = 0;
        if (isAuthoritativeForDueSoon(activeCourses.length, courses)) {
          try {
            upcomingCount = await syncUpcomingTasks(notionToken, args.databaseId, courses);
          } catch (e) {
            console.error(`[NOTION] Due Soon reconciliation failed (preserved existing rows): ${e instanceof Error ? e.message : e}`);
          }
        } else {
          console.error('[NOTION] Skipping Due Soon reconciliation: non-authoritative/partial sync — existing reminders preserved.');
        }

        // 6. Cleanup stale pages — skip when there are no verified active courses.
        // An empty enrollment snapshot is not authoritative for destructive archival
        // (it would otherwise archive every page).
        const archived = activeCourses.length > 0
          ? await cleanupStalePages(notionToken, args.databaseId, buildActiveCodes(courses))
          : 0;

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
