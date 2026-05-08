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
  createAssignmentPage,
  updateAssignmentPage,
  syncAssignments,
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
    expect(map.size).toBe(2);
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
    expect(map.size).toBe(2);
    expect(map.get('CS100|A1')).toBe('p1');
    expect(map.get('CS100|A2')).toBe('p2');
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
    expect(map.size).toBe(1);
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

  it('sends Weight % as number property', async () => {
    const spy = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ id: 'np' }) });
    vi.stubGlobal('fetch', spy);
    await createAssignmentPage(TOKEN, DB_ID, assignment);
    const body = JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.properties['Weight %'].number).toBe(10);
  });

  it('sends null Grade % as null number', async () => {
    const spy = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ id: 'np' }) });
    vi.stubGlobal('fetch', spy);
    await createAssignmentPage(TOKEN, DB_ID, assignment);
    const body = JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.properties['Grade %'].number).toBeNull();
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

  it('sends updated Grade %', async () => {
    const spy = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', spy);
    await updateAssignmentPage(TOKEN, 'page-1', assignment);
    const body = JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.properties['Grade %'].number).toBe(85.5);
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
