/**
 * Unit tests for notionClient.ts — written FIRST (TDD).
 *
 * Covers the contract for:
 *   - validateNotionToken: liveness probe against /v1/users/me
 *   - queryAllPages: pagination + dedup-key map building
 *   - createAssignmentPage: correct Notion property shape
 *   - updateAssignmentPage: PATCH to correct endpoint
 *   - syncAssignments: dedup, count tracking, error resilience, rate-limit delay
 *
 * All tests mock global fetch — no Notion account required.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('../../src/utils/supabase.js', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }),
      upsert: async () => ({ error: null }),
    }),
  },
}));

import {
  validateNotionToken,
  queryAllPages,
  createCoursePage,
  updateCoursePage,
  createAssignmentPage,
  updateAssignmentPage,
  syncAssignments,
  type CourseData,
  type NotionAssignment,
} from '../../src/study/notionClient.js';

// ─── Fetch mock helpers ────────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  }));
}

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let call = 0;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
    const r = responses[Math.min(call++, responses.length - 1)];
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: async () => r.body,
    };
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TOKEN = 'secret_test_token_abc123';
const DB_ID = 'db-1234-5678';

const baseCourseData: CourseData = {
  orgUnitId: 1,
  name: 'Intro to CS',
  code: 'CS135',
  isActive: true,
  assignments: [{
    name: 'Assignment 1',
    dueDate: '2026-03-15T23:59:00Z',
    maxPoints: 20,
    status: 'Not Started',
  }],
  grades: [],
  announcements: [],
};

// ─── validateNotionToken ───────────────────────────────────────────────────────

describe('validateNotionToken', () => {
  it('returns true when /v1/users/me responds 200', async () => {
    mockFetch(200, { object: 'user', id: 'user-abc' });
    expect(await validateNotionToken(TOKEN)).toBe(true);
  });

  it('returns false on 401 (token invalid or revoked)', async () => {
    mockFetch(401, { object: 'error', code: 'unauthorized' });
    expect(await validateNotionToken(TOKEN)).toBe(false);
  });

  it('returns false on 403 (token lacks permission)', async () => {
    mockFetch(403, { object: 'error', code: 'restricted_resource' });
    expect(await validateNotionToken(TOKEN)).toBe(false);
  });

  it('returns false on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    expect(await validateNotionToken(TOKEN)).toBe(false);
  });

  it('sends Authorization header with Bearer prefix', async () => {
    const spy = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', spy);
    await validateNotionToken(TOKEN);
    const [, opts] = spy.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('sends Notion-Version header', async () => {
    const spy = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', spy);
    await validateNotionToken(TOKEN);
    const [, opts] = spy.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)['Notion-Version']).toBeDefined();
  });
});

// ─── queryAllPages ─────────────────────────────────────────────────────────────

describe('queryAllPages', () => {
  it('returns empty map when database has no pages', async () => {
    mockFetch(200, { results: [], has_more: false });
    const map = await queryAllPages(TOKEN, DB_ID);
    expect(map.size).toBe(0);
  });

  it('builds dedup map keyed by courseCode|title', async () => {
    mockFetch(200, {
      results: [
        {
          id: 'page-1',
          properties: {
            Name: { title: [{ plain_text: 'Assignment 1' }] },
            'Course Code': { rich_text: [{ plain_text: 'CS135' }] },
          },
        },
        {
          id: 'page-2',
          properties: {
            Name: { title: [{ plain_text: 'Quiz 1' }] },
            'Course Code': { rich_text: [{ plain_text: 'MATH135' }] },
          },
        },
      ],
      has_more: false,
    });
    const map = await queryAllPages(TOKEN, DB_ID);
    expect(map.get('CS135|Assignment 1')).toBe('page-1');
    expect(map.get('MATH135|Quiz 1')).toBe('page-2');
    // Also stores courseCode-only keys for course-page dedup
    expect(map.get('CS135')).toBe('page-1');
    expect(map.get('MATH135')).toBe('page-2');
  });

  it('follows pagination — fetches all pages when has_more is true', async () => {
    mockFetchSequence([
      {
        status: 200,
        body: {
          results: [
            { id: 'p1', properties: { Name: { title: [{ plain_text: 'A1' }] }, 'Course Code': { rich_text: [{ plain_text: 'CS100' }] } } },
          ],
          has_more: true,
          next_cursor: 'cursor-abc',
        },
      },
      {
        status: 200,
        body: {
          results: [
            { id: 'p2', properties: { Name: { title: [{ plain_text: 'A2' }] }, 'Course Code': { rich_text: [{ plain_text: 'CS100' }] } } },
          ],
          has_more: false,
        },
      },
    ]);
    const map = await queryAllPages(TOKEN, DB_ID);
    // Both courseCode|title and courseCode keys (CS100 points to last page seen)
    expect(map.get('CS100|A1')).toBe('p1');
    expect(map.get('CS100|A2')).toBe('p2');
    expect(map.get('CS100')).toBeDefined();
  });

  it('handles pages with missing Name (skips gracefully)', async () => {
    mockFetch(200, {
      results: [
        {
          id: 'page-broken',
          properties: {
            Name: { title: [] }, // empty title
            'Course Code': { rich_text: [{ plain_text: 'CS135' }] },
          },
        },
        {
          id: 'page-ok',
          properties: {
            Name: { title: [{ plain_text: 'Assignment 2' }] },
            'Course Code': { rich_text: [{ plain_text: 'CS135' }] },
          },
        },
      ],
      has_more: false,
    });
    const map = await queryAllPages(TOKEN, DB_ID);
    // page-broken has no title text, should be skipped
    expect(map.get('CS135|Assignment 2')).toBe('page-ok');
    // Also has courseCode key
    expect(map.get('CS135')).toBe('page-ok');
  });

  it('throws on non-200 response (e.g. 404 — wrong database ID)', async () => {
    mockFetch(404, { object: 'error', code: 'object_not_found' });
    await expect(queryAllPages(TOKEN, DB_ID)).rejects.toThrow();
  });
});

// ─── createAssignmentPage ──────────────────────────────────────────────────────

describe('createAssignmentPage', () => {
  const assignment: NotionAssignment = {
    title: 'Lab 3',
    courseName: 'Introduction to CS',
    courseCode: 'CS135',
    dueDate: '2026-03-15T23:59:00Z',
    type: 'assignment',
    status: 'Not Started',
    gradePercent: null,
    weightPercent: 10,
  };

  it('POSTs to /v1/pages with correct parent database_id', async () => {
    const spy = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ id: 'new-page' }) });
    vi.stubGlobal('fetch', spy);
    await createAssignmentPage(TOKEN, DB_ID, assignment);
    const [url, opts] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/pages');
    const body = JSON.parse(opts.body as string);
    expect(body.parent.database_id).toBe(DB_ID);
  });

  it('sends Name as title property', async () => {
    const spy = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ id: 'np' }) });
    vi.stubGlobal('fetch', spy);
    await createAssignmentPage(TOKEN, DB_ID, assignment);
    const body = JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.properties.Name.title[0].text.content).toBe('Lab 3');
  });

  it('sends Course as select property', async () => {
    const spy = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ id: 'np' }) });
    vi.stubGlobal('fetch', spy);
    await createAssignmentPage(TOKEN, DB_ID, assignment);
    const body = JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.properties['Course'].select.name).toBe('Introduction to CS');
  });

  it('sends Course Code as rich_text property', async () => {
    const spy = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ id: 'np' }) });
    vi.stubGlobal('fetch', spy);
    await createAssignmentPage(TOKEN, DB_ID, assignment);
    const body = JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.properties['Course Code'].rich_text[0].text.content).toBe('CS135');
  });

  it('sends Due Date as date property with start ISO string', async () => {
    const spy = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ id: 'np' }) });
    vi.stubGlobal('fetch', spy);
    await createAssignmentPage(TOKEN, DB_ID, assignment);
    const body = JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.properties['Due Date'].date.start).toBe('2026-03-15T23:59:00Z');
  });

  it('sends null dueDate as null date property', async () => {
    const spy = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ id: 'np' }) });
    vi.stubGlobal('fetch', spy);
    await createAssignmentPage(TOKEN, DB_ID, { ...assignment, dueDate: null });
    const body = JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.properties['Due Date'].date).toBeNull();
  });

  it('sends Status as select property', async () => {
    const spy = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ id: 'np' }) });
    vi.stubGlobal('fetch', spy);
    await createAssignmentPage(TOKEN, DB_ID, assignment);
    const body = JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.properties['Status'].select.name).toBe('Not Started');
  });

  it('sends Course Code as rich_text in legacy create', async () => {
    const spy = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ id: 'np' }) });
    vi.stubGlobal('fetch', spy);
    await createAssignmentPage(TOKEN, DB_ID, assignment);
    const body = JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.properties['Course Code'].rich_text[0].text.content).toBe('CS135');
  });

  it('sends Type as select property', async () => {
    const spy = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ id: 'np' }) });
    vi.stubGlobal('fetch', spy);
    await createAssignmentPage(TOKEN, DB_ID, assignment);
    const body = JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.properties['Type'].select.name).toBe('Assignment');
  });

  it('sends Type "Quiz" for quiz type', async () => {
    const spy = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ id: 'np' }) });
    vi.stubGlobal('fetch', spy);
    await createAssignmentPage(TOKEN, DB_ID, { ...assignment, type: 'quiz' });
    const body = JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.properties['Type'].select.name).toBe('Quiz');
  });

  it('throws on API error (e.g. 400 invalid property)', async () => {
    mockFetch(400, { object: 'error', code: 'validation_error', message: 'invalid property' });
    await expect(createAssignmentPage(TOKEN, DB_ID, assignment)).rejects.toThrow();
  });
});

// ─── updateAssignmentPage ──────────────────────────────────────────────────────

describe('updateAssignmentPage', () => {
  const assignment: NotionAssignment = {
    title: 'Lab 3',
    courseName: 'Introduction to CS',
    courseCode: 'CS135',
    dueDate: '2026-03-15T23:59:00Z',
    type: 'assignment',
    status: 'Submitted',
    gradePercent: 85.5,
    weightPercent: 10,
  };

  it('PATCHes /v1/pages/{pageId}', async () => {
    const spy = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ id: 'page-1' }) });
    vi.stubGlobal('fetch', spy);
    await updateAssignmentPage(TOKEN, 'page-1', assignment);
    const [url, opts] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/pages/page-1');
    expect(opts.method).toBe('PATCH');
  });

  it('sends updated Status', async () => {
    const spy = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', spy);
    await updateAssignmentPage(TOKEN, 'page-1', assignment);
    const body = JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.properties['Status'].select.name).toBe('Submitted');
  });

  it('throws on API error', async () => {
    mockFetch(404, { object: 'error', code: 'object_not_found' });
    await expect(updateAssignmentPage(TOKEN, 'nonexistent', assignment)).rejects.toThrow();
  });
});

// ─── syncAssignments ──────────────────────────────────────────────────────────

describe('syncAssignments', () => {
  const makeAssignment = (title: string, courseCode: string = 'CS135'): NotionAssignment => ({
    title,
    courseName: 'Intro to CS',
    courseCode,
    dueDate: '2026-04-01T23:59:00Z',
    type: 'assignment',
    status: 'Not Started',
    gradePercent: null,
    weightPercent: 5,
  });

  beforeEach(() => {
    // queryAllPages returns empty by default (no existing pages)
    mockFetch(200, { results: [], has_more: false });
  });

  it('returns zero counts when assignments list is empty', async () => {
    const result = await syncAssignments(TOKEN, DB_ID, [], { delayMs: 0 });
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('creates a new page and increments created count', async () => {
    mockFetchSequence([
      { status: 200, body: { results: [], has_more: false } }, // queryAllPages
      { status: 200, body: { id: 'new-page-1' } },             // createAssignmentPage
    ]);
    const result = await syncAssignments(TOKEN, DB_ID, [makeAssignment('A1')], { delayMs: 0 });
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('updates existing page (found in queryAllPages) and increments updated count', async () => {
    mockFetchSequence([
      {
        status: 200,
        body: {
          results: [{
            id: 'existing-page',
            properties: {
              Name: { title: [{ plain_text: 'A1' }] },
              'Course Code': { rich_text: [{ plain_text: 'CS135' }] },
            },
          }],
          has_more: false,
        },
      }, // queryAllPages returns A1 already exists
      { status: 200, body: { id: 'existing-page' } }, // updateAssignmentPage
    ]);
    const result = await syncAssignments(TOKEN, DB_ID, [makeAssignment('A1')], { delayMs: 0 });
    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('does not duplicate: create for new, update for existing in the same batch', async () => {
    mockFetchSequence([
      {
        status: 200,
        body: {
          results: [{
            id: 'existing-page',
            properties: {
              Name: { title: [{ plain_text: 'A1' }] },
              'Course Code': { rich_text: [{ plain_text: 'CS135' }] },
            },
          }],
          has_more: false,
        },
      },
      { status: 200, body: { id: 'existing-page' } }, // update A1
      { status: 200, body: { id: 'new-page' } },      // create A2
    ]);
    const result = await syncAssignments(
      TOKEN, DB_ID,
      [makeAssignment('A1'), makeAssignment('A2')],
      { delayMs: 0 },
    );
    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('increments failed count and continues when one create fails', async () => {
    mockFetchSequence([
      { status: 200, body: { results: [], has_more: false } }, // queryAllPages
      { status: 400, body: { object: 'error', message: 'bad request' } }, // create A1 fails
      { status: 200, body: { id: 'new-page-2' } },                        // create A2 succeeds
    ]);
    const result = await syncAssignments(
      TOKEN, DB_ID,
      [makeAssignment('A1'), makeAssignment('A2')],
      { delayMs: 0 },
    );
    expect(result.failed).toBe(1);
    expect(result.created).toBe(1);
  });

  it('respects delayMs between writes (timing check)', async () => {
    vi.useFakeTimers();
    mockFetchSequence([
      { status: 200, body: { results: [], has_more: false } },
      { status: 200, body: { id: 'p1' } },
      { status: 200, body: { id: 'p2' } },
    ]);

    const promise = syncAssignments(
      TOKEN, DB_ID,
      [makeAssignment('A1'), makeAssignment('A2')],
      { delayMs: 350 },
    );

    // Advance timers by 700ms to cover 2 × 350ms delays
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.created).toBe(2);
    vi.useRealTimers();
  });

  it('dedup key is courseCode|title — same title in different courses does not collide', async () => {
    mockFetchSequence([
      { status: 200, body: { results: [], has_more: false } },
      { status: 200, body: { id: 'p1' } },
      { status: 200, body: { id: 'p2' } },
    ]);
    const result = await syncAssignments(
      TOKEN, DB_ID,
      [makeAssignment('Assignment 1', 'CS135'), makeAssignment('Assignment 1', 'MATH135')],
      { delayMs: 0 },
    );
    expect(result.created).toBe(2);
  });
});

const MARKER = '🔄 Horizon Live Sync (auto-managed)';

/** okJson — a fetch-Response-like object for a 200 JSON body. */
function okJson(body: unknown) {
  return { status: 200, ok: true, json: async () => body };
}

/** errJson — a fetch-Response-like object for a non-2xx JSON error. */
function errJson(status: number, message = 'boom') {
  return { status, ok: false, json: async () => ({ message }) };
}

/**
 * Route Notion fetch calls by URL + method against a simple in-memory page model,
 * recording every call so tests can assert on deletes/appends/patches. Supports
 * paginated block-children reads and optional forced failures for specific
 * mutations (append and per-id delete) to exercise failure paths.
 */
function routedNotionFetch(opts: {
  pageId: string;
  pageChildren: unknown[];
  childrenByBlockId?: Record<string, unknown[]>;
  // Optional pagination for the page's own children: pages after the first.
  pageChildrenPages?: Array<{ results: unknown[]; nextCursor: string | null }>;
  // Force failures: non-2xx status for the append PATCH and/or specific DELETEs.
  failAppendStatus?: number;
  failDeleteStatusById?: Record<string, number>;
}) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });

    const childMatch = url.match(/\/blocks\/([^/?]+)\/children/);
    if (method === 'GET' && childMatch) {
      const blockId = childMatch[1];
      if (blockId === opts.pageId) {
        // Paginated page children.
        if (opts.pageChildrenPages) {
          const cursorMatch = url.match(/[?&]start_cursor=([^&]+)/);
          const cursor = cursorMatch ? decodeURIComponent(cursorMatch[1]) : null;
          if (cursor === null) {
            const p = opts.pageChildrenPages[0];
            return okJson({ results: p.results, has_more: p.nextCursor !== null, next_cursor: p.nextCursor });
          }
          const idx = opts.pageChildrenPages.findIndex((_p, i) => opts.pageChildrenPages![i - 1]?.nextCursor === cursor);
          const p = opts.pageChildrenPages[idx];
          return okJson({ results: p.results, has_more: p.nextCursor !== null, next_cursor: p.nextCursor });
        }
        return okJson({ results: opts.pageChildren, has_more: false, next_cursor: null });
      }
      return okJson({ results: opts.childrenByBlockId?.[blockId] || [], has_more: false, next_cursor: null });
    }

    // Append (PATCH block children) — optionally forced to fail.
    if (method === 'PATCH' && childMatch && childMatch[1] === opts.pageId && opts.failAppendStatus) {
      return errJson(opts.failAppendStatus);
    }
    // DELETE a specific block — optionally forced to fail.
    if (method === 'DELETE') {
      const idMatch = url.match(/\/blocks\/([^/?]+)$/);
      const id = idMatch?.[1];
      const failStatus = id ? opts.failDeleteStatusById?.[id] : undefined;
      if (failStatus) return errJson(failStatus);
    }
    // PATCH properties, successful append/delete, POST create → 200 {}.
    return okJson({});
  });
  vi.stubGlobal('fetch', spy);

  const deletedIds = () => calls
    .filter((c) => c.method === 'DELETE')
    .map((c) => (c.url.match(/\/blocks\/([^/?]+)$/) || [])[1])
    .filter(Boolean) as string[];
  const appendCalls = () => calls.filter((c) =>
    c.method === 'PATCH' && c.url.includes(`/blocks/${opts.pageId}/children`));
  const propsPatch = () => calls.find((c) =>
    c.method === 'PATCH' && c.url.includes(`/pages/${opts.pageId}`));
  return { spy, calls, deletedIds, appendCalls, propsPatch };
}

/** Flatten the rich_text of a bullet block into a plain string. */
function bulletText(block: any): string {
  return (block?.bulleted_list_item?.rich_text || [])
    .map((t: any) => t?.text?.content ?? t?.plain_text ?? '')
    .join('');
}

describe('course-page safety updates', () => {
  it('creates course pages with a managed live-sync callout section', async () => {
    const { spy } = routedNotionFetch({ pageId: 'db', pageChildren: [] });

    await createCoursePage(TOKEN, DB_ID, baseCourseData);

    const body = JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.children[0].type).toBe('callout');
    expect(body.children[0].callout.rich_text[0].text.content).toMatch(/live sync/i);
    // Managed body MUST nest under callout.children, never as a sibling `children`
    // key (Notion rejects the sibling shape with a 400).
    expect(Array.isArray(body.children[0].callout.children)).toBe(true);
    expect(body.children[0].children).toBeUndefined();
  });

  it('replaces only the managed callout and never deletes manual blocks', async () => {
    const r = routedNotionFetch({
      pageId: 'page-1',
      pageChildren: [
        { id: 'manual-block', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Manual notes' }] } },
        { id: 'managed-callout', type: 'callout', callout: { rich_text: [{ plain_text: MARKER }] } },
      ],
      childrenByBlockId: { 'managed-callout': [] },
    });

    await updateCoursePage(TOKEN, 'page-1', baseCourseData);

    const deleted = r.deletedIds();
    expect(deleted).toEqual(['managed-callout']);
    expect(deleted.some((id) => id.includes('manual-block'))).toBe(false);
    // Exactly one fresh managed callout is appended.
    expect(r.appendCalls()).toHaveLength(1);
  });

  it('skips body replacement AND assignment-property resets when all sources are empty', async () => {
    const preserveCourse: CourseData = {
      ...baseCourseData,
      assignments: [],
      grades: [],
      syncMetadata: { preserveExistingAssignments: true },
    };
    const r = routedNotionFetch({ pageId: 'page-1', pageChildren: [] });

    await updateCoursePage(TOKEN, 'page-1', preserveCourse);

    expect(r.deletedIds()).toHaveLength(0);
    expect(r.appendCalls()).toHaveLength(0);
    // Properties patch must NOT overwrite assignment-derived fields (or blank Grade).
    const props = r.propsPatch()?.body?.properties ?? {};
    expect(props).not.toHaveProperty('Assignments');
    expect(props).not.toHaveProperty('Next Due');
    expect(props).not.toHaveProperty('Grade');
  });

  it('preserves existing assignment bullets (with due date, link, status) verbatim on partial source failure', async () => {
    // A live sync yielded one assignment, but a source FAILED — the previously-synced
    // '⬜ Homework 9 — Due: Apr 1' (with a link) must NOT be rewritten/degraded.
    const partialCourse: CourseData = {
      ...baseCourseData,
      assignments: [{ name: 'Assignment 1', dueDate: '2026-03-15T23:59:00Z', maxPoints: 20, status: 'Not Started' }],
      grades: [],
      syncMetadata: { assignmentSourceFailures: 1 },
    };
    const r = routedNotionFetch({
      pageId: 'page-1',
      pageChildren: [{ id: 'mc', type: 'callout', callout: { rich_text: [{ plain_text: MARKER }] } }],
      childrenByBlockId: {
        mc: [{
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ plain_text: '⬜ Homework 9 — Due: Apr 1, 11:59 PM' }] },
        }],
      },
    });

    await updateCoursePage(TOKEN, 'page-1', partialCourse);

    // Body is left completely untouched → no field can be lost.
    expect(r.deletedIds()).toHaveLength(0);
    expect(r.appendCalls()).toHaveLength(0);
    const props = r.propsPatch()?.body?.properties ?? {};
    expect(props).not.toHaveProperty('Assignments');
    expect(props).not.toHaveProperty('Next Due');
  });

  it('respects a user-set 📤 Submitted status on re-render (Unicode-aware status parsing)', async () => {
    const course: CourseData = {
      ...baseCourseData,
      assignments: [{ name: 'Assignment 1', dueDate: '2026-03-15T23:59:00Z', maxPoints: 20, status: 'Not Started' }],
    };
    const r = routedNotionFetch({
      pageId: 'page-1',
      pageChildren: [{ id: 'mc', type: 'callout', callout: { rich_text: [{ plain_text: MARKER }] } }],
      childrenByBlockId: {
        // User manually flipped the emoji to 📤 (Submitted). 📤 is a surrogate pair,
        // so this only survives if the status regex uses the `u` flag.
        mc: [{
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ plain_text: '📤 Assignment 1 — Due: Mar 15, 11:59 PM' }] },
        }],
      },
    });

    await updateCoursePage(TOKEN, 'page-1', course);

    const appended = r.appendCalls()[0]?.body?.children?.[0];
    // Managed content MUST be nested inside callout.children (a sibling `children` key
    // is rejected by Notion with a 400) — so read the children from callout.children.
    expect(appended?.children).toBeUndefined();
    const bullets: any[] = (appended?.callout?.children || []).filter((b: any) => b.type === 'bulleted_list_item');
    const a1 = bullets.find((b) => bulletText(b).includes('Assignment 1'));
    expect(a1).toBeDefined();
    // Rendered with the Submitted emoji, not reset to ⬜ Not Started.
    expect(bulletText(a1).startsWith('📤')).toBe(true);
  });

  it('never deletes ANY unmarked block on a legacy page — appends the managed callout only', async () => {
    // A legacy page has generated sections as unmarked direct children, with a
    // MANUAL paragraph placed BETWEEN two of them. Because no unmarked block can be
    // proven Horizon-generated, migration must delete nothing (position must never
    // decide deletion) and simply append the managed callout.
    const r = routedNotionFetch({
      pageId: 'page-1',
      pageChildren: [
        { id: 'h-assign', type: 'heading_2', heading_2: { rich_text: [{ plain_text: '📋 Assignments' }] } },
        { id: 'b-old', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: '⬜ Old A' }] } },
        // Manual paragraph sitting between two recognized legacy generated sections.
        { id: 'user-note', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'My own study notes' }] } },
        { id: 'h-grades', type: 'heading_2', heading_2: { rich_text: [{ plain_text: '📊 Grades' }] } },
        { id: 'b-grade', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'Midterm: 90/100' }] } },
      ],
    });

    await updateCoursePage(TOKEN, 'page-1', baseCourseData);

    // Non-destructive guarantee: nothing on a legacy page is deleted or modified.
    expect(r.deletedIds()).toHaveLength(0);
    // The manual paragraph between the two generated sections survives byte-for-byte:
    // it is never the target of a DELETE or a block-update PATCH.
    const touchedManual = r.calls.some((c) =>
      c.url.includes('/blocks/user-note') && (c.method === 'DELETE' || c.method === 'PATCH'));
    expect(touchedManual).toBe(false);
    // Exactly one managed callout is appended (the documented one-time cleanup path
    // leaves the old sections for the user to remove once, by hand).
    expect(r.appendCalls()).toHaveLength(1);
  });

  it('replaces only the callout on an already-migrated page (no legacy duplication thereafter)', async () => {
    // After the first sync a legacy page also has a managed callout; subsequent syncs
    // replace only that callout and still never touch the leftover legacy blocks.
    const r = routedNotionFetch({
      pageId: 'page-1',
      pageChildren: [
        { id: 'h-assign', type: 'heading_2', heading_2: { rich_text: [{ plain_text: '📋 Assignments' }] } },
        { id: 'b-old', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: '⬜ Old A' }] } },
        { id: 'mc', type: 'callout', callout: { rich_text: [{ plain_text: MARKER }] } },
      ],
      childrenByBlockId: { mc: [] },
    });

    await updateCoursePage(TOKEN, 'page-1', baseCourseData);

    expect(r.deletedIds()).toEqual(['mc']);
    expect(r.deletedIds()).not.toContain('b-old');
    expect(r.appendCalls()).toHaveLength(1);
  });

  it('is idempotent: syncing a page that already has a managed callout keeps exactly one', async () => {
    const model = {
      pageId: 'page-1',
      pageChildren: [{ id: 'mc', type: 'callout', callout: { rich_text: [{ plain_text: MARKER }] } }],
      childrenByBlockId: { mc: [] },
    };
    // First sync.
    let r = routedNotionFetch(model);
    await updateCoursePage(TOKEN, 'page-1', baseCourseData);
    expect(r.deletedIds()).toEqual(['mc']);
    expect(r.appendCalls()).toHaveLength(1);

    // Second sync of the same steady-state page — still exactly one delete + append.
    r = routedNotionFetch(model);
    await updateCoursePage(TOKEN, 'page-1', baseCourseData);
    expect(r.deletedIds()).toEqual(['mc']);
    expect(r.appendCalls()).toHaveLength(1);
  });

  it('finds and replaces the managed callout even when it is beyond the first 100 blocks (pagination)', async () => {
    const fillers = Array.from({ length: 100 }, (_v, i) => ({
      id: `filler-${i}`, type: 'paragraph', paragraph: { rich_text: [{ plain_text: `note ${i}` }] },
    }));
    const r = routedNotionFetch({
      pageId: 'page-1',
      pageChildren: [],
      pageChildrenPages: [
        { results: fillers, nextCursor: 'cursor-2' },
        { results: [{ id: 'mc', type: 'callout', callout: { rich_text: [{ plain_text: MARKER }] } }], nextCursor: null },
      ],
      childrenByBlockId: { mc: [] },
    });

    await updateCoursePage(TOKEN, 'page-1', baseCourseData);

    // Without pagination the callout (on page 2) would be missed and duplicated.
    expect(r.deletedIds()).toEqual(['mc']);
    expect(r.appendCalls()).toHaveLength(1);
  });

  it('appends the replacement BEFORE deleting the old callout (append-first ordering)', async () => {
    const r = routedNotionFetch({
      pageId: 'page-1',
      pageChildren: [{ id: 'mc', type: 'callout', callout: { rich_text: [{ plain_text: MARKER }] } }],
      childrenByBlockId: { mc: [] },
    });

    await updateCoursePage(TOKEN, 'page-1', baseCourseData);

    const appendIdx = r.calls.findIndex((c) => c.method === 'PATCH' && c.url.includes('/blocks/page-1/children'));
    const deleteIdx = r.calls.findIndex((c) => c.method === 'DELETE');
    expect(appendIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    // The new content must be written before the old callout is removed.
    expect(appendIdx).toBeLessThan(deleteIdx);
  });

  it('preserves the old managed callout when the append fails (never erases the body)', async () => {
    const r = routedNotionFetch({
      pageId: 'page-1',
      pageChildren: [{ id: 'mc', type: 'callout', callout: { rich_text: [{ plain_text: MARKER }] } }],
      childrenByBlockId: { mc: [] },
      failAppendStatus: 500,
    });

    await expect(updateCoursePage(TOKEN, 'page-1', baseCourseData)).rejects.toThrow(/append managed content failed \(500\)/i);
    // The append failed, so NOTHING was deleted — the existing callout is intact.
    expect(r.deletedIds()).toHaveLength(0);
  });

  it('leaves a recoverable duplicate and reports when old-callout cleanup fails after a successful append', async () => {
    const r = routedNotionFetch({
      pageId: 'page-1',
      pageChildren: [{ id: 'mc', type: 'callout', callout: { rich_text: [{ plain_text: MARKER }] } }],
      childrenByBlockId: { mc: [] },
      failDeleteStatusById: { mc: 409 },
    });

    // Cleanup failure is surfaced…
    await expect(updateCoursePage(TOKEN, 'page-1', baseCourseData)).rejects.toThrow(/cleanup of old managed callout/i);
    // …the fresh callout WAS appended (append happened before the failed delete)…
    expect(r.appendCalls()).toHaveLength(1);
    // …and the delete of the old callout was attempted (both callouts now coexist —
    // a recoverable duplicate, no data lost).
    expect(r.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/blocks/mc'))).toBe(true);
  });

  it('surfaces a non-2xx properties PATCH as a thrown error', async () => {
    // Force the page-properties PATCH to fail (a mutation before any body change).
    const spy = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'GET') return okJson({ results: [], has_more: false, next_cursor: null });
      if (method === 'PATCH' && url.includes('/pages/page-1')) return errJson(400, 'bad property');
      return okJson({});
    });
    vi.stubGlobal('fetch', spy);

    await expect(updateCoursePage(TOKEN, 'page-1', baseCourseData)).rejects.toThrow(/update page failed \(400\)/i);
  });
});
