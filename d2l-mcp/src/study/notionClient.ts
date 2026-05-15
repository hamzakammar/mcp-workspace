/**
 * Notion API client — direct fetch, no SDK dependency.
 *
 * Syncs D2L course data to a user's Notion database:
 *   - One page per course
 *   - Properties: course name, code, status, next due date
 *   - Page body: assignments, grades, upcoming events
 *
 * Database schema expected:
 *   Name          (title)
 *   Course Code   (rich_text)
 *   Status        (select: Active | Ended)
 *   Next Due      (date)
 *   Grade         (rich_text)
 *   Assignments   (number)
 */

const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CourseData {
  orgUnitId: number;
  name: string;
  code: string;
  isActive: boolean;
  assignments: AssignmentInfo[];
  grades: GradeInfo[];
  announcements: AnnouncementInfo[];
  schedule?: ScheduleItem[];
}

export interface ScheduleItem {
  week: string;
  topic: string;
  readings?: string;
}

export interface AssignmentInfo {
  name: string;
  dueDate: string | null;
  maxPoints: number | null;
  status: 'Not Started' | 'Submitted' | 'Graded';
  grade?: string | null;
  url?: string;
}

export interface GradeInfo {
  name: string;
  pointsNumerator: number | null;
  pointsDenominator: number | null;
  weightedNumerator: number | null;
  weightedDenominator: number | null;
}

export interface AnnouncementInfo {
  title: string;
  date: string;
  body: string;
  url?: string;
}

export interface SyncResult {
  created: number;
  updated: number;
  failed: number;
}

export interface SyncOptions {
  delayMs?: number;
}

// Keep old types for backward compat with tests
export interface NotionAssignment {
  title: string;
  courseName: string;
  courseCode: string;
  dueDate: string | null;
  type: 'assignment' | 'quiz';
  status?: 'Not Started' | 'In Progress' | 'Submitted' | 'Graded';
  gradePercent?: number | null;
  weightPercent?: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function notionHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Format a date in Eastern Time for display */
function formatDateET(isoDate: string, includeTime = true): string {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: 'America/Toronto',
    month: 'short',
    day: 'numeric',
    ...(includeTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  };
  return new Date(isoDate).toLocaleString('en-US', opts);
}

function buildCourseProperties(course: CourseData): Record<string, unknown> {
  // Find next upcoming due date
  const now = new Date();
  const upcomingDues = course.assignments
    .filter(a => a.dueDate && new Date(a.dueDate) > now)
    .sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime());
  const nextDue = upcomingDues.length > 0 ? upcomingDues[0].dueDate : null;

  // Compute overall grade summary
  const gradedItems = course.grades.filter(g => g.pointsNumerator !== null && g.pointsDenominator);
  let gradeSummary = '';
  if (gradedItems.length > 0) {
    const totalEarned = gradedItems.reduce((s, g) => s + (g.weightedNumerator ?? g.pointsNumerator ?? 0), 0);
    const totalPossible = gradedItems.reduce((s, g) => s + (g.weightedDenominator ?? g.pointsDenominator ?? 0), 0);
    if (totalPossible > 0) {
      gradeSummary = `${Math.round((totalEarned / totalPossible) * 100)}%`;
    }
  }

  return {
    'Name': {
      title: [{ text: { content: course.name } }],
    },
    'Course Code': {
      rich_text: [{ text: { content: course.code } }],
    },
    'Status': {
      select: { name: course.isActive ? 'Active' : 'Ended' },
    },
    'Next Due': {
      date: nextDue ? { start: nextDue } : null,
    },
    'Grade': {
      rich_text: [{ text: { content: gradeSummary } }],
    },
    'Assignments': {
      number: course.assignments.length,
    },
  };
}

function buildCourseBody(course: CourseData): unknown[] {
  const blocks: unknown[] = [];

  // ── Assignments section ──
  if (course.assignments.length > 0) {
    blocks.push({
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: [{ text: { content: '📋 Assignments' } }] },
    });

    for (const a of course.assignments) {
      const duePart = a.dueDate ? ` — Due: ${formatDateET(a.dueDate)}` : '';
      const gradePart = a.grade ? ` [${a.grade}]` : '';
      const statusEmoji = a.status === 'Graded' ? '✅' : a.status === 'Submitted' ? '📤' : '⬜';

      // Make assignment name a clickable link if URL is available
      const nameRichText: unknown[] = a.url
        ? [{ text: { content: `${statusEmoji} `, link: null } }, { text: { content: a.name, link: { url: a.url } } }, { text: { content: `${duePart}${gradePart}` } }]
        : [{ text: { content: `${statusEmoji} ${a.name}${duePart}${gradePart}` } }];

      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: nameRichText },
      });
    }
  }

  // ── Grades section ──
  if (course.grades.length > 0) {
    blocks.push({
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: [{ text: { content: '📊 Grades' } }] },
    });

    for (const g of course.grades) {
      const score = g.pointsNumerator !== null && g.pointsDenominator
        ? `${g.pointsNumerator}/${g.pointsDenominator}`
        : 'Not graded';
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [{ text: { content: `${g.name}: ${score}` } }],
        },
      });
    }
  }

  // ── Schedule section ──
  // Filter out schedule items that are just duplicates of assignments (some outlines
  // have one table parsed as both assessments and schedule)
  const assignmentNames = new Set(course.assignments.map(a => a.name.toLowerCase()));
  const realSchedule = (course.schedule || []).filter(s => {
    const topic = s.topic.toLowerCase();
    const week = s.week.toLowerCase();
    // Skip if week or topic matches an assignment name
    if (assignmentNames.has(topic) || assignmentNames.has(week)) return false;
    // Skip if topic/week looks like an assessment item
    const combined = `${week} ${topic}`;
    if (/^(assignment|quiz|bonus|midterm|final|exam|end of course)/i.test(week)) return false;
    if (/^(assignment|quiz|bonus|midterm|final|exam|end of course)/i.test(topic)) return false;
    // Skip if topic is just a date (not a real topic)
    if (/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|opens)/i.test(topic)) return false;
    return true;
  });

  if (realSchedule.length > 0) {
    blocks.push({
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: [{ text: { content: '📅 Weekly Schedule' } }] },
    });

    for (const s of realSchedule.slice(0, 15)) {
      const readingsPart = s.readings ? ` — ${s.readings}` : '';
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [{ text: { content: `Week ${s.week}: ${s.topic}${readingsPart}` } }],
        },
      });
    }
  }

  // ── Announcements section (last 5) ──
  if (course.announcements.length > 0) {
    blocks.push({
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: [{ text: { content: '📢 Recent Announcements' } }] },
    });

    for (const ann of course.announcements.slice(0, 5)) {
      const date = formatDateET(ann.date, false);
      // Build rich text: title as link if URL available, plain text otherwise
      const titleRichText: unknown[] = ann.url
        ? [{ text: { content: `[${date}] `, link: null } }, { text: { content: ann.title, link: { url: ann.url } } }]
        : [{ text: { content: `[${date}] ${ann.title}` } }];

      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: titleRichText },
      });

      // Show body snippet (strip HTML, cap at 500 chars)
      const snippet = ann.body.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (snippet) {
        blocks.push({
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ text: { content: `    ${snippet}${ann.body.length > 500 ? '...' : ''}` } }],
          },
        });
      }
    }
  }

  // If no content at all, add a placeholder
  if (blocks.length === 0) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ text: { content: 'No assignments, grades, or announcements found for this course yet.' } }],
      },
    });
  }

  return blocks;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensure the database has the expected properties. Creates missing ones via PATCH.
 */
export async function ensureDatabaseSchema(token: string, databaseId: string): Promise<void> {
  const requiredProperties: Record<string, unknown> = {
    'Course Code': { rich_text: {} },
    'Status': { select: { options: [{ name: 'Active', color: 'green' }, { name: 'Ended', color: 'gray' }] } },
    'Next Due': { date: {} },
    'Grade': { rich_text: {} },
    'Assignments': { number: {} },
  };

  const resp = await fetch(`${NOTION_BASE}/databases/${databaseId}`, {
    method: 'PATCH',
    headers: notionHeaders(token),
    body: JSON.stringify({ properties: requiredProperties }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { message?: string };
    throw new Error(`Failed to set up database schema (${resp.status}): ${err.message ?? 'unknown'}`);
  }
}

export async function validateNotionToken(token: string): Promise<boolean> {
  try {
    const resp = await fetch(`${NOTION_BASE}/users/me`, {
      headers: notionHeaders(token),
    });
    return resp.status === 200;
  } catch {
    return false;
  }
}

/**
 * Query all pages in a Notion database and return a dedup map.
 * Key: `courseCode|title` (for assignment pages) or `courseCode` (for course pages)
 * Value: Notion page ID
 */
export async function queryAllPages(token: string, databaseId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body['start_cursor'] = cursor;

    const resp = await fetch(`${NOTION_BASE}/databases/${databaseId}/query`, {
      method: 'POST',
      headers: notionHeaders(token),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as { message?: string };
      throw new Error(`Notion query failed (${resp.status}): ${err.message ?? 'unknown error'}`);
    }

    const data = await resp.json() as {
      results: Array<{
        id: string;
        properties: {
          Name?: { title: Array<{ plain_text: string }> };
          'Course Code'?: { rich_text: Array<{ plain_text: string }> };
        };
      }>;
      has_more: boolean;
      next_cursor?: string;
    };

    for (const page of data.results) {
      const titleParts = page.properties?.Name?.title ?? [];
      const title = titleParts.map((t) => t.plain_text).join('').trim();
      const courseCode = (page.properties?.['Course Code']?.rich_text ?? [])
        .map((t) => t.plain_text).join('').trim();

      if (!title) continue;
      // Store both formats: courseCode|title (for legacy assignment dedup)
      // and courseCode alone (for course-page dedup)
      map.set(`${courseCode}|${title}`, page.id);
      if (courseCode) {
        map.set(courseCode, page.id);
      }
    }

    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return map;
}

/**
 * Create a course page in the Notion database with full content.
 */
export async function createCoursePage(
  token: string,
  databaseId: string,
  course: CourseData,
): Promise<void> {
  const body = {
    parent: { database_id: databaseId },
    properties: buildCourseProperties(course),
    children: buildCourseBody(course).slice(0, 100), // Notion max 100 blocks per create
  };

  const resp = await fetch(`${NOTION_BASE}/pages`, {
    method: 'POST',
    headers: notionHeaders(token),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { message?: string };
    throw new Error(`Notion create page failed (${resp.status}): ${err.message ?? 'unknown error'}`);
  }
}

/**
 * Update an existing course page — updates properties and replaces content.
 */
export async function updateCoursePage(
  token: string,
  pageId: string,
  course: CourseData,
): Promise<void> {
  // Update properties
  const resp = await fetch(`${NOTION_BASE}/pages/${pageId}`, {
    method: 'PATCH',
    headers: notionHeaders(token),
    body: JSON.stringify({
      properties: buildCourseProperties(course),
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { message?: string };
    throw new Error(`Notion update page failed (${resp.status}): ${err.message ?? 'unknown error'}`);
  }

  // Delete existing blocks and replace with new content
  // First, get existing blocks
  const blocksResp = await fetch(`${NOTION_BASE}/blocks/${pageId}/children?page_size=100`, {
    headers: notionHeaders(token),
  });
  if (blocksResp.ok) {
    const blocksData = await blocksResp.json() as { results: Array<{ id: string }> };
    // Delete old blocks
    for (const block of blocksData.results) {
      await fetch(`${NOTION_BASE}/blocks/${block.id}`, {
        method: 'DELETE',
        headers: notionHeaders(token),
      });
    }
  }

  // Append new content
  const newBlocks = buildCourseBody(course).slice(0, 100);
  if (newBlocks.length > 0) {
    await fetch(`${NOTION_BASE}/blocks/${pageId}/children`, {
      method: 'PATCH',
      headers: notionHeaders(token),
      body: JSON.stringify({ children: newBlocks }),
    });
  }
}

/**
 * Sync course data to Notion — one page per course.
 */
export async function syncCourses(
  token: string,
  databaseId: string,
  courses: CourseData[],
  options: SyncOptions = {},
): Promise<SyncResult> {
  const delayMs = options.delayMs ?? 350;
  const result: SyncResult = { created: 0, updated: 0, failed: 0 };

  if (courses.length === 0) return result;

  // Ensure database has required properties before syncing
  await ensureDatabaseSchema(token, databaseId);

  const existingPages = await queryAllPages(token, databaseId);

  for (let i = 0; i < courses.length; i++) {
    const course = courses[i];
    const existingPageId = existingPages.get(course.code);

    try {
      if (existingPageId) {
        await updateCoursePage(token, existingPageId, course);
        result.updated++;
      } else {
        await createCoursePage(token, databaseId, course);
        result.created++;
      }
    } catch (e) {
      console.error(`[NOTION] Failed to sync course ${course.code}: ${e instanceof Error ? e.message : e}`);
      result.failed++;
    }

    if (delayMs > 0 && i < courses.length - 1) {
      await delay(delayMs);
    }
  }

  return result;
}

// ─── Legacy compat (for existing tests) ──────────────────────────────────────

export async function createAssignmentPage(
  token: string,
  databaseId: string,
  assignment: NotionAssignment,
): Promise<void> {
  const resp = await fetch(`${NOTION_BASE}/pages`, {
    method: 'POST',
    headers: notionHeaders(token),
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties: {
        'Name': { title: [{ text: { content: assignment.title } }] },
        'Course': { select: { name: assignment.courseName } },
        'Course Code': { rich_text: [{ text: { content: assignment.courseCode } }] },
        'Due Date': { date: assignment.dueDate ? { start: assignment.dueDate } : null },
        'Status': { select: { name: assignment.status ?? 'Not Started' } },
        'Type': { select: { name: assignment.type === 'quiz' ? 'Quiz' : 'Assignment' } },
      },
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { message?: string };
    throw new Error(`Notion create page failed (${resp.status}): ${err.message ?? 'unknown error'}`);
  }
}

export async function updateAssignmentPage(
  token: string,
  pageId: string,
  assignment: NotionAssignment,
): Promise<void> {
  const resp = await fetch(`${NOTION_BASE}/pages/${pageId}`, {
    method: 'PATCH',
    headers: notionHeaders(token),
    body: JSON.stringify({
      properties: {
        'Name': { title: [{ text: { content: assignment.title } }] },
        'Course': { select: { name: assignment.courseName } },
        'Course Code': { rich_text: [{ text: { content: assignment.courseCode } }] },
        'Due Date': { date: assignment.dueDate ? { start: assignment.dueDate } : null },
        'Status': { select: { name: assignment.status ?? 'Not Started' } },
        'Type': { select: { name: assignment.type === 'quiz' ? 'Quiz' : 'Assignment' } },
      },
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { message?: string };
    throw new Error(`Notion update page failed (${resp.status}): ${err.message ?? 'unknown error'}`);
  }
}

export async function syncAssignments(
  token: string,
  databaseId: string,
  assignments: NotionAssignment[],
  options: SyncOptions = {},
): Promise<SyncResult> {
  const delayMs = options.delayMs ?? 350;
  const result: SyncResult = { created: 0, updated: 0, failed: 0 };
  if (assignments.length === 0) return result;

  const existingPages = await queryAllPages(token, databaseId);
  for (let i = 0; i < assignments.length; i++) {
    const assignment = assignments[i];
    const dedupKey = `${assignment.courseCode}|${assignment.title}`;
    const existingPageId = existingPages.get(dedupKey);
    try {
      if (existingPageId) {
        await updateAssignmentPage(token, existingPageId, assignment);
        result.updated++;
      } else {
        await createAssignmentPage(token, databaseId, assignment);
        result.created++;
      }
    } catch {
      result.failed++;
    }
    if (delayMs > 0 && i < assignments.length - 1) {
      await delay(delayMs);
    }
  }
  return result;
}
