/**
 * Notion API client — direct fetch, no SDK dependency.
 *
 * Handles assignment sync to a user's Notion database:
 *   - Token validation
 *   - Querying existing pages (for dedup)
 *   - Creating / updating assignment pages
 *   - Rate-limited bulk sync (Notion allows ~3 req/s avg)
 *
 * Database schema expected:
 *   Name          (title)
 *   Course        (select)
 *   Course Code   (rich_text)
 *   Due Date      (date)
 *   Status        (select: Not Started | In Progress | Submitted | Graded)
 *   Grade %       (number)
 *   Weight %      (number)
 *   Type          (select: Assignment | Quiz)
 */

const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// ─── Types ────────────────────────────────────────────────────────────────────

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

export interface SyncResult {
  created: number;
  updated: number;
  failed: number;
}

export interface SyncOptions {
  /** Milliseconds to wait between write calls (default: 350 for Notion rate limits) */
  delayMs?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function notionHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

function buildProperties(assignment: NotionAssignment): Record<string, unknown> {
  return {
    'Name': {
      title: [{ text: { content: assignment.title } }],
    },
    'Course': {
      select: { name: assignment.courseName },
    },
    'Course Code': {
      rich_text: [{ text: { content: assignment.courseCode } }],
    },
    'Due Date': {
      date: assignment.dueDate ? { start: assignment.dueDate } : null,
    },
    'Status': {
      select: { name: assignment.status ?? 'Not Started' },
    },
    'Grade %': {
      number: assignment.gradePercent ?? null,
    },
    'Weight %': {
      number: assignment.weightPercent ?? null,
    },
    'Type': {
      select: { name: assignment.type === 'quiz' ? 'Quiz' : 'Assignment' },
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Probe /v1/users/me to check if the token is valid and has API access.
 */
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
 * Key: `courseCode|title`  →  Value: Notion page ID
 *
 * Handles pagination automatically.
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

      if (!title) continue; // skip pages with empty title
      map.set(`${courseCode}|${title}`, page.id);
    }

    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return map;
}

/**
 * Create a new assignment page in the Notion database.
 */
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
      properties: buildProperties(assignment),
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { message?: string };
    throw new Error(`Notion create page failed (${resp.status}): ${err.message ?? 'unknown error'}`);
  }
}

/**
 * Update an existing Notion page's properties.
 */
export async function updateAssignmentPage(
  token: string,
  pageId: string,
  assignment: NotionAssignment,
): Promise<void> {
  const resp = await fetch(`${NOTION_BASE}/pages/${pageId}`, {
    method: 'PATCH',
    headers: notionHeaders(token),
    body: JSON.stringify({
      properties: buildProperties(assignment),
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { message?: string };
    throw new Error(`Notion update page failed (${resp.status}): ${err.message ?? 'unknown error'}`);
  }
}

/**
 * Sync a list of assignments to a Notion database.
 *
 * - Queries existing pages first (dedup by courseCode|title).
 * - Creates pages for new assignments; patches existing ones.
 * - Continues past individual failures (increments failed count).
 * - Waits delayMs between each write to stay under Notion rate limits.
 */
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

    // Rate limiting: wait between writes (but not after the last one)
    if (delayMs > 0 && i < assignments.length - 1) {
      await delay(delayMs);
    }
  }

  return result;
}
