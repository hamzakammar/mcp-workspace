/**
 * Unit tests for the sync_to_notion MCP tool handler.
 *
 * Tests the tool contract: error messages, D2L data mapping,
 * and sync result formatting. All external calls are mocked.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// ─── Module mocks (must come before imports) ──────────────────────────────────

vi.mock('../../src/utils/supabase.js', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: async () => ({ data: null, error: null }),
          }),
        }),
      }),
      upsert: async () => ({ error: null }),
    }),
  },
}));

vi.mock('../../src/utils/userContext.js', () => ({
  getUserId: vi.fn().mockReturnValue('user-test-1'),
  runWithUserId: vi.fn((_userId: string, fn: () => unknown) => fn()),
}));

vi.mock('../../src/study/notionClient.js', () => ({
  validateNotionToken: vi.fn(),
  syncCourses: vi.fn(),
  syncAssignments: vi.fn(),
}));

vi.mock('../../src/study/notionAuth.js', () => ({
  getNotionToken: vi.fn(),
}));

vi.mock('../../src/client.js', () => ({
  client: {
    getMyEnrollments: vi.fn(),
    getDropboxFolders: vi.fn(),
    getQuizzes: vi.fn(),
    getQuizAttempts: vi.fn(),
    getMyCalendarEvents: vi.fn(),
    getMyGradeValues: vi.fn(),
    getNews: vi.fn(),
  },
}));

import { notionTools, backgroundNotionSync } from '../../src/tools/notion.js';
import { syncCourses } from '../../src/study/notionClient.js';
import { getNotionToken } from '../../src/study/notionAuth.js';
import { client } from '../../src/client.js';
import { getUserId } from '../../src/utils/userContext.js';

const syncMock = vi.mocked(syncCourses);
const tokenMock = vi.mocked(getNotionToken);
const enrollmentsMock = vi.mocked(client.getMyEnrollments);
const dropboxMock = vi.mocked(client.getDropboxFolders);
const quizzesMock = vi.mocked(client.getQuizzes);
const quizAttemptsMock = vi.mocked(client.getQuizAttempts);
const calendarMock = vi.mocked(client.getMyCalendarEvents);
const gradesMock = vi.mocked(client.getMyGradeValues);
const newsMock = vi.mocked(client.getNews);

const TOOL = notionTools.sync_to_notion;

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Not connected errors ─────────────────────────────────────────────────────

describe('sync_to_notion — not connected', () => {
  it('returns error when Notion token is not set', async () => {
    tokenMock.mockResolvedValue(null);
    const result = JSON.parse(await TOOL.handler({ databaseId: 'db-1' }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/notion/i);
  });

  it('includes connect hint when Notion not connected', async () => {
    tokenMock.mockResolvedValue(null);
    const result = JSON.parse(await TOOL.handler({ databaseId: 'db-1' }));
    expect(result.hint).toBeDefined();
  });

  it('returns success with 0 courses when no active enrollments', async () => {
    tokenMock.mockResolvedValue('secret_test');
    enrollmentsMock.mockResolvedValue({ Items: [] } as any);
    syncMock.mockResolvedValue({ created: 0, updated: 0, failed: 0 });
    const result = JSON.parse(await TOOL.handler({ databaseId: 'db-1' }));
    expect(result.success).toBe(true);
    expect(result.coursesChecked).toBe(0);
  });
});

// ─── Course data fetching ─────────────────────────────────────────────────────

describe('sync_to_notion — course data', () => {
  beforeEach(() => {
    tokenMock.mockResolvedValue('secret_test');
    enrollmentsMock.mockResolvedValue({
      Items: [{
        OrgUnit: { Id: 123, Name: 'Intro to CS', Code: 'CS135', Type: { Code: 'Course Offering' } },
        Access: { IsActive: true, CanAccess: true, StartDate: null, EndDate: null },
      }],
    } as any);
    dropboxMock.mockResolvedValue([]);
    quizzesMock.mockResolvedValue([]);
    quizAttemptsMock.mockResolvedValue([]);
    calendarMock.mockResolvedValue({ Objects: [] } as any);
    gradesMock.mockResolvedValue([]);
    newsMock.mockResolvedValue([]);
  });

  it('passes course data to syncCourses', async () => {
    dropboxMock.mockResolvedValue([{
      Id: 1, Name: 'Assignment 1',
      DueDate: '2026-04-15T23:59:00Z',
      Assessment: { ScoreDenominator: 20 },
    }] as any);

    let capturedCourses: any[] = [];
    syncMock.mockImplementation(async (_t, _db, courses) => {
      capturedCourses = courses;
      return { created: 1, updated: 0, failed: 0 };
    });

    await TOOL.handler({ databaseId: 'db-1' });
    expect(capturedCourses).toHaveLength(1);
    expect(capturedCourses[0].name).toBe('Intro to CS');
    expect(capturedCourses[0].code).toBe('CS135');
    expect(capturedCourses[0].assignments).toHaveLength(1);
    expect(capturedCourses[0].assignments[0].name).toBe('Assignment 1');
  });

  it('fetches grades for each course', async () => {
    gradesMock.mockResolvedValue([{
      GradeObjectName: 'Midterm',
      PointsNumerator: 85,
      PointsDenominator: 100,
      WeightedNumerator: null,
      WeightedDenominator: null,
    }] as any);

    let capturedCourses: any[] = [];
    syncMock.mockImplementation(async (_t, _db, courses) => {
      capturedCourses = courses;
      return { created: 1, updated: 0, failed: 0 };
    });

    await TOOL.handler({ databaseId: 'db-1' });
    expect(capturedCourses[0].grades).toHaveLength(1);
    expect(capturedCourses[0].grades[0].name).toBe('Midterm');
    expect(capturedCourses[0].grades[0].pointsNumerator).toBe(85);
  });

  it('fetches announcements for each course', async () => {
    newsMock.mockResolvedValue([{
      Title: 'Welcome!',
      StartDate: '2026-05-01T00:00:00Z',
      Body: { Html: '<p>Hello class</p>' },
    }] as any);

    let capturedCourses: any[] = [];
    syncMock.mockImplementation(async (_t, _db, courses) => {
      capturedCourses = courses;
      return { created: 1, updated: 0, failed: 0 };
    });

    await TOOL.handler({ databaseId: 'db-1' });
    expect(capturedCourses[0].announcements).toHaveLength(1);
    expect(capturedCourses[0].announcements[0].title).toBe('Welcome!');
  });

  it('marks assignment sync metadata to preserve existing content when all live sources are empty', async () => {
    let capturedCourses: any[] = [];
    syncMock.mockImplementation(async (_t, _db, courses) => {
      capturedCourses = courses;
      return { created: 1, updated: 0, failed: 0 };
    });

    await TOOL.handler({ databaseId: 'db-1' });
    expect(capturedCourses[0].assignments).toHaveLength(0);
    expect(capturedCourses[0].syncMetadata?.preserveExistingAssignments).toBe(true);
  });

  it('merges mixed assignment sources (dropbox + quizzes + calendar) without duplicates', async () => {
    dropboxMock.mockResolvedValue([{
      Id: 11,
      Name: 'Assignment 1',
      DueDate: '2026-10-01T23:59:00Z',
      Assessment: { ScoreDenominator: 20 },
    }] as any);
    quizzesMock.mockResolvedValue({
      Objects: [{
        Id: 22,
        Name: 'Quiz 1',
        DueDate: '2026-10-02T23:59:00Z',
        IsActive: true,
        AttemptsAllowed: 1,
      }],
    } as any);
    quizAttemptsMock.mockResolvedValue({ Objects: [{ Attempt: { AttemptNumber: 1 } }] } as any);
    calendarMock.mockResolvedValue({
      Objects: [
        {
          Title: 'Assignment 1',
          EndDateTime: '2026-10-01T23:59:00Z',
          OrgUnitName: 'CS135',
          CalendarEventViewUrl: 'https://calendar/a1',
        },
        {
          Title: 'Project Milestone',
          EndDateTime: null,
          OrgUnitName: 'CS135',
          CalendarEventViewUrl: 'https://calendar/p1',
        },
        // Non-assessment events on the same course must be filtered out entirely.
        { Title: 'Weekly Lecture', EndDateTime: '2026-10-03T10:00:00Z', OrgUnitName: 'CS135' },
        { Title: 'CS135 Office Hours', EndDateTime: '2026-10-04T10:00:00Z', OrgUnitName: 'CS135' },
      ],
    } as any);

    let capturedCourses: any[] = [];
    syncMock.mockImplementation(async (_t, _db, courses) => {
      capturedCourses = courses;
      return { created: 1, updated: 0, failed: 0 };
    });

    await TOOL.handler({ databaseId: 'db-1' });
    const names = capturedCourses[0].assignments.map((a: any) => a.name);
    // Assignment 1 (dropbox + calendar dedup), Quiz 1, and the calendar 'Project
    // Milestone' (assessment keyword) are included; lecture/office-hours are dropped.
    expect(names).toEqual(['Assignment 1', 'Quiz 1', 'Project Milestone']);
    expect(names).not.toContain('Weekly Lecture');
    expect(names).not.toContain('CS135 Office Hours');
    expect(capturedCourses[0].assignments[2].dueDate).toBeNull();
  });

  it('uses exact normalized course-code matching for calendar merges', async () => {
    enrollmentsMock.mockResolvedValue({
      Items: [{
        OrgUnit: { Id: 999, Name: 'Physics Lab', Code: 'PHYS121L', Type: { Code: 'Course Offering' } },
        Access: { IsActive: true, CanAccess: true, StartDate: null, EndDate: null },
      }],
    } as any);
    // Both events are genuine assessments (Dropbox-associated), so the ONLY reason
    // the PHYS121 event is excluded is the exact course-code mismatch with PHYS121L.
    calendarMock.mockResolvedValue({
      Objects: [
        {
          Title: 'Assignment 2',
          EndDateTime: '2026-10-01T10:00:00Z',
          OrgUnitName: 'PHYS121',
          AssociatedEntity: { AssociatedEntityType: 'Dropbox' },
        },
        {
          Title: 'Lab Report 3',
          EndDateTime: '2026-10-03T10:00:00Z',
          OrgUnitName: 'PHYS121L',
          AssociatedEntity: { AssociatedEntityType: 'Dropbox' },
        },
      ],
    } as any);

    let capturedCourses: any[] = [];
    syncMock.mockImplementation(async (_t, _db, courses) => {
      capturedCourses = courses;
      return { created: 1, updated: 0, failed: 0 };
    });

    await TOOL.handler({ databaseId: 'db-1' });
    expect(capturedCourses[0].assignments.map((a: any) => a.name)).toEqual(['Lab Report 3']);
  });

  it('records partial source failures so existing assignments can be preserved downstream', async () => {
    dropboxMock.mockRejectedValue(new Error('dropbox unavailable'));
    quizzesMock.mockResolvedValue({ Objects: [] } as any);
    calendarMock.mockResolvedValue({
      // A real assessment survives the successful calendar source...
      Objects: [{ Title: 'Assignment 4', EndDateTime: '2026-10-05T10:00:00Z', OrgUnitName: 'CS135' }],
    } as any);

    let capturedCourses: any[] = [];
    syncMock.mockImplementation(async (_t, _db, courses) => {
      capturedCourses = courses;
      return { created: 1, updated: 0, failed: 0 };
    });

    await TOOL.handler({ databaseId: 'db-1' });
    expect(capturedCourses[0].assignments.map((a: any) => a.name)).toContain('Assignment 4');
    // ...and the dropbox failure is recorded so downstream can preserve records.
    expect(capturedCourses[0].syncMetadata?.assignmentSourceFailures).toBeGreaterThan(0);
  });

  it('normalizes realistic D2L codes (section/term tokens) without cross-course bleed', async () => {
    // Real D2L code glues a section token onto the code ("1261_CS135_LEC001"); the
    // leading letter of LEC must NOT be read as a course suffix, and CS135 must stay
    // distinct from the lab CS135L.
    enrollmentsMock.mockResolvedValue({
      Items: [{
        OrgUnit: { Id: 123, Name: 'Intro to CS', Code: '1261_CS135_LEC001', Type: { Code: 'Course Offering' } },
        Access: { IsActive: true, CanAccess: true, StartDate: null, EndDate: null },
      }],
    } as any);
    calendarMock.mockResolvedValue({
      Objects: [
        { Title: 'Assignment 7', OrgUnitName: 'CS135', AssociatedEntity: { AssociatedEntityType: 'Dropbox' } },
        { Title: 'Assignment 8', OrgUnitName: 'CS135L', AssociatedEntity: { AssociatedEntityType: 'Dropbox' } },
      ],
    } as any);

    let capturedCourses: any[] = [];
    syncMock.mockImplementation(async (_t, _db, courses) => {
      capturedCourses = courses;
      return { created: 1, updated: 0, failed: 0 };
    });

    await TOOL.handler({ databaseId: 'db-1' });
    const names = capturedCourses[0].assignments.map((a: any) => a.name);
    expect(names).toContain('Assignment 7');   // CS135 matches the lecture section
    expect(names).not.toContain('Assignment 8'); // CS135L (lab) is a distinct course
  });

  it('excludes lectures, tutorials, office hours, and bare lab meetings from calendar ingestion', async () => {
    calendarMock.mockResolvedValue({
      Objects: [
        { Title: 'Assignment 5', EndDateTime: '2026-11-01T10:00:00Z', OrgUnitName: 'CS135' },
        { Title: 'Quiz 3', EndDateTime: '2026-11-02T10:00:00Z', OrgUnitName: 'CS135', AssociatedEntity: { AssociatedEntityType: 'Quiz' } },
        { Title: 'Final Exam', EndDateTime: '2026-11-03T10:00:00Z', OrgUnitName: 'CS135' },
        { Title: 'Course Project Proposal due', EndDateTime: '2026-11-04T10:00:00Z', OrgUnitName: 'CS135' },
        { Title: 'Lecture 12', EndDateTime: '2026-11-05T10:00:00Z', OrgUnitName: 'CS135' },
        { Title: 'Tutorial 4', EndDateTime: '2026-11-06T10:00:00Z', OrgUnitName: 'CS135' },
        { Title: 'Instructor Office Hours', EndDateTime: '2026-11-07T10:00:00Z', OrgUnitName: 'CS135' },
        { Title: 'Lab 2', EndDateTime: '2026-11-08T10:00:00Z', OrgUnitName: 'CS135' },
        { Title: 'CS135 Weekly Seminar', EndDateTime: '2026-11-09T10:00:00Z', OrgUnitName: 'CS135' },
      ],
    } as any);

    let capturedCourses: any[] = [];
    syncMock.mockImplementation(async (_t, _db, courses) => {
      capturedCourses = courses;
      return { created: 1, updated: 0, failed: 0 };
    });

    await TOOL.handler({ databaseId: 'db-1' });
    const names = capturedCourses[0].assignments.map((a: any) => a.name);
    // Assessment / deadline events are included…
    expect(names).toEqual(expect.arrayContaining(['Assignment 5', 'Quiz 3', 'Final Exam', 'Course Project Proposal due']));
    // …scheduled meetings are excluded.
    for (const excluded of ['Lecture 12', 'Tutorial 4', 'Instructor Office Hours', 'Lab 2', 'CS135 Weekly Seminar']) {
      expect(names).not.toContain(excluded);
    }
  });
});

// ─── Summary format ──────────────────────────────────────────────────────────

describe('sync_to_notion — summary format', () => {
  beforeEach(() => {
    tokenMock.mockResolvedValue('secret_test');
    enrollmentsMock.mockResolvedValue({
      Items: [{
        OrgUnit: { Id: 1, Name: 'Intro to CS', Code: 'CS135', Type: { Code: 'Course Offering' } },
        Access: { IsActive: true, CanAccess: true, StartDate: null, EndDate: null },
      }],
    } as any);
    dropboxMock.mockResolvedValue([]);
    quizzesMock.mockResolvedValue([]);
    quizAttemptsMock.mockResolvedValue([]);
    calendarMock.mockResolvedValue({ Objects: [] } as any);
    gradesMock.mockResolvedValue([]);
    newsMock.mockResolvedValue([]);
  });

  it('returns success: true on successful sync', async () => {
    syncMock.mockResolvedValue({ created: 1, updated: 0, failed: 0 });
    const result = JSON.parse(await TOOL.handler({ databaseId: 'db-1' }));
    expect(result.success).toBe(true);
  });

  it('includes created, updated, failed counts in result', async () => {
    syncMock.mockResolvedValue({ created: 3, updated: 2, failed: 1 });
    const result = JSON.parse(await TOOL.handler({ databaseId: 'db-1' }));
    expect(result.created).toBe(3);
    expect(result.updated).toBe(2);
    expect(result.failed).toBe(1);
  });

  it('includes coursesChecked count', async () => {
    syncMock.mockResolvedValue({ created: 1, updated: 0, failed: 0 });
    const result = JSON.parse(await TOOL.handler({ databaseId: 'db-1' }));
    expect(result.coursesChecked).toBe(1);
  });

  it('includes summary string', async () => {
    syncMock.mockResolvedValue({ created: 1, updated: 0, failed: 0 });
    const result = JSON.parse(await TOOL.handler({ databaseId: 'db-1' }));
    expect(typeof result.summary).toBe('string');
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it('indicates auto-sync is enabled after first sync', async () => {
    syncMock.mockResolvedValue({ created: 1, updated: 0, failed: 0 });
    const result = JSON.parse(await TOOL.handler({ databaseId: 'db-1' }));
    expect(result.autoSyncEnabled).toBe(true);
  });
});

// ─── Error resilience ────────────────────────────────────────────────────────

describe('sync_to_notion — error resilience', () => {
  it('returns error if syncCourses throws (e.g. invalid database ID)', async () => {
    tokenMock.mockResolvedValue('secret_test');
    enrollmentsMock.mockResolvedValue({
      Items: [{
        OrgUnit: { Id: 1, Name: 'CS', Code: 'CS135', Type: { Code: 'Course Offering' } },
        Access: { IsActive: true, CanAccess: true, StartDate: null, EndDate: null },
      }],
    } as any);
    dropboxMock.mockResolvedValue([]);
    quizzesMock.mockResolvedValue([]);
    quizAttemptsMock.mockResolvedValue([]);
    calendarMock.mockResolvedValue({ Objects: [] } as any);
    gradesMock.mockResolvedValue([]);
    newsMock.mockResolvedValue([]);
    syncMock.mockRejectedValue(new Error('Notion query failed (404): object_not_found'));

    const result = JSON.parse(await TOOL.handler({ databaseId: 'bad-db-id' }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/404|not_found|Notion/i);
  });
});

// ─── Background sync fail-closed ───────────────────────────────────────────────

describe('backgroundNotionSync — fail closed', () => {
  const ORIGINAL = process.env.BACKGROUND_NOTION_SYNC_ENABLED;

  beforeEach(() => {
    tokenMock.mockResolvedValue('secret_test');
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.BACKGROUND_NOTION_SYNC_ENABLED;
    else process.env.BACKGROUND_NOTION_SYNC_ENABLED = ORIGINAL;
  });

  it('does NOT run when the enable flag is unset (unset means disabled)', async () => {
    delete process.env.BACKGROUND_NOTION_SYNC_ENABLED;
    await backgroundNotionSync('fc-unset');
    expect(tokenMock).not.toHaveBeenCalled();
    expect(enrollmentsMock).not.toHaveBeenCalled();
  });

  it('does NOT run for any value other than the exact string "true"', async () => {
    process.env.BACKGROUND_NOTION_SYNC_ENABLED = 'false';
    await backgroundNotionSync('fc-false');
    process.env.BACKGROUND_NOTION_SYNC_ENABLED = '1';
    await backgroundNotionSync('fc-one');
    process.env.BACKGROUND_NOTION_SYNC_ENABLED = 'TRUE';
    await backgroundNotionSync('fc-upper');
    expect(tokenMock).not.toHaveBeenCalled();
    expect(enrollmentsMock).not.toHaveBeenCalled();
  });

  it('runs only when the flag is exactly "true"', async () => {
    process.env.BACKGROUND_NOTION_SYNC_ENABLED = 'true';
    await backgroundNotionSync('fc-true');
    expect(tokenMock).toHaveBeenCalledWith('fc-true');
  });
});

// ─── Cross-user isolation ──────────────────────────────────────────────────────

describe('sync_to_notion — cross-user isolation', () => {
  const getUserIdMock = vi.mocked(getUserId);

  beforeEach(() => {
    enrollmentsMock.mockResolvedValue({
      Items: [{
        OrgUnit: { Id: 123, Name: 'Intro to CS', Code: 'CS135', Type: { Code: 'Course Offering' } },
        Access: { IsActive: true, CanAccess: true, StartDate: null, EndDate: null },
      }],
    } as any);
    dropboxMock.mockResolvedValue([]);
    quizzesMock.mockResolvedValue([]);
    quizAttemptsMock.mockResolvedValue([]);
    calendarMock.mockResolvedValue({ Objects: [] } as any);
    gradesMock.mockResolvedValue([]);
    newsMock.mockResolvedValue([]);
    syncMock.mockResolvedValue({ created: 1, updated: 0, failed: 0 } as any);
  });

  afterEach(() => {
    getUserIdMock.mockReturnValue('user-test-1');
  });

  it('scopes the Notion token and database to the current user, with no leakage between users', async () => {
    tokenMock.mockImplementation(async (uid: string) => `token-for-${uid}`);

    getUserIdMock.mockReturnValue('userA');
    await TOOL.handler({ databaseId: 'dbA' });

    getUserIdMock.mockReturnValue('userB');
    await TOOL.handler({ databaseId: 'dbB' });

    const tokensUsed = syncMock.mock.calls.map((c) => c[0]);
    const dbsUsed = syncMock.mock.calls.map((c) => c[1]);
    expect(tokensUsed).toEqual(['token-for-userA', 'token-for-userB']);
    expect(dbsUsed).toEqual(['dbA', 'dbB']);
  });
});

// ─── Stale-page + Due Soon reconciliation safety ───────────────────────────────

/**
 * Stub global fetch against a small Notion model. The Due-Soon-filtered query and
 * the unfiltered stale-page (queryAllPages) query can each be seeded with EXISTING
 * rows so tests are non-vacuous, and archive PATCHes are recorded.
 */
function stubNotionFetch(opts: {
  dueSoonRows?: string[];
  allPagesRows?: Array<{ id: string; code: string; name: string }>;
  archiveStatusById?: Record<string, number>;
  typePropertyExists?: boolean;
}) {
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? String(init.body) : '';
    // GET on a database — report whether the "Type" select property already exists so
    // the reconciliation can skip a redundant (index-invalidating) schema PATCH.
    if (/\/databases\/[^/]+$/.test(String(url)) && method === 'GET') {
      return ok({ properties: opts.typePropertyExists ? { Type: { type: 'select' } } : {} });
    }
    if (String(url).endsWith('/query') && method === 'POST') {
      if (body.includes('Due Soon')) {
        return ok({ results: (opts.dueSoonRows || []).map((id) => ({ id })), has_more: false });
      }
      return ok({
        results: (opts.allPagesRows || []).map((r) => ({
          id: r.id,
          properties: {
            Name: { title: [{ plain_text: r.name }] },
            'Course Code': { rich_text: [{ plain_text: r.code }] },
          },
        })),
        has_more: false,
      });
    }
    // Archive PATCH — optionally forced to fail for a given page id.
    if (method === 'PATCH' && body.includes('"archived":true')) {
      const id = (String(url).match(/\/pages\/([^/?]+)$/) || [])[1];
      const failStatus = id ? opts.archiveStatusById?.[id] : undefined;
      if (failStatus) return { ok: false, status: failStatus, json: async () => ({ message: 'boom' }) };
    }
    return ok({});
  });
  vi.stubGlobal('fetch', spy);

  const archivedIds = () => spy.mock.calls
    .filter((c) => (String((c[1] as RequestInit)?.method || '').toUpperCase() === 'PATCH')
      && String((c[1] as RequestInit)?.body || '').includes('"archived":true'))
    .map((c) => (String(c[0]).match(/\/pages\/([^/?]+)$/) || [])[1])
    .filter(Boolean) as string[];
  const dueSoonQueried = () => spy.mock.calls.some((c) =>
    String(c[0]).endsWith('/query') && String((c[1] as RequestInit)?.body || '').includes('Due Soon'));
  const stalePageQueried = () => spy.mock.calls.some((c) =>
    String(c[0]).endsWith('/query') && !String((c[1] as RequestInit)?.body || '').includes('Due Soon'));
  // A schema PATCH = PATCH on /databases/{id} carrying a "Type" property definition.
  const schemaPatched = () => spy.mock.calls.some((c) =>
    /\/databases\/[^/]+$/.test(String(c[0]))
    && String((c[1] as RequestInit)?.method || '').toUpperCase() === 'PATCH'
    && String((c[1] as RequestInit)?.body || '').includes('"Type"'));
  return { spy, archivedIds, dueSoonQueried, stalePageQueried, schemaPatched };
}

describe('sync_to_notion — cleanup + Due Soon reconciliation safety', () => {
  beforeEach(() => {
    tokenMock.mockResolvedValue('secret_test');
    dropboxMock.mockResolvedValue([]);
    quizzesMock.mockResolvedValue([]);
    quizAttemptsMock.mockResolvedValue([]);
    calendarMock.mockResolvedValue({ Objects: [] } as any);
    gradesMock.mockResolvedValue([]);
    newsMock.mockResolvedValue([]);
    syncMock.mockResolvedValue({ created: 0, updated: 0, failed: 0 } as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('empty enrollment archives NOTHING — existing course pages AND Due Soon rows are preserved', async () => {
    enrollmentsMock.mockResolvedValue({ Items: [] } as any);
    const s = stubNotionFetch({
      dueSoonRows: ['duesoon-1'], // an existing reminder row is present…
      allPagesRows: [{ id: 'course-page-1', code: 'OLD101', name: 'Old Course' }],
    });

    const result = JSON.parse(await TOOL.handler({ databaseId: 'db-1' }));
    expect(result.success).toBe(true);

    // …yet neither the reminder nor the course page is archived, and neither the
    // Due Soon reconciliation nor the stale-page cleanup query is even issued.
    expect(s.archivedIds()).toEqual([]);
    expect(s.dueSoonQueried()).toBe(false);
    expect(s.stalePageQueried()).toBe(false);
  });

  it('partial source failure archives NO existing Due Soon rows for the affected course', async () => {
    enrollmentsMock.mockResolvedValue({
      Items: [{
        OrgUnit: { Id: 123, Name: 'Intro to CS', Code: 'CS135', Type: { Code: 'Course Offering' } },
        Access: { IsActive: true, CanAccess: true, StartDate: null, EndDate: null },
      }],
    } as any);
    // Dropbox fails → the course carries assignmentSourceFailures > 0 (non-authoritative).
    dropboxMock.mockRejectedValue(new Error('dropbox unavailable'));
    const s = stubNotionFetch({
      dueSoonRows: ['duesoon-cs135'],                                  // existing reminder
      allPagesRows: [{ id: 'cs135-page', code: 'CS135', name: 'Intro to CS' }], // still-active page
    });

    const result = JSON.parse(await TOOL.handler({ databaseId: 'db-1' }));
    expect(result.success).toBe(true);

    // Due Soon reconciliation is skipped entirely → the existing reminder survives.
    expect(s.dueSoonQueried()).toBe(false);
    expect(s.archivedIds()).not.toContain('duesoon-cs135');
    // (Stale-page cleanup may run since there is a verified active course, but the
    // active CS135 page is not archived.)
    expect(s.archivedIds()).not.toContain('cs135-page');
  });

  it('fully authoritative snapshot DOES archive genuinely stale Due Soon reminders', async () => {
    enrollmentsMock.mockResolvedValue({
      Items: [{
        OrgUnit: { Id: 123, Name: 'Intro to CS', Code: 'CS135', Type: { Code: 'Course Offering' } },
        Access: { IsActive: true, CanAccess: true, StartDate: null, EndDate: null },
      }],
    } as any);
    // A real assignment (>=1, no failures) → no preservation metadata → authoritative.
    dropboxMock.mockResolvedValue([{
      Id: 11, Name: 'Assignment 1', DueDate: '2026-09-20T23:59:00Z', Assessment: { ScoreDenominator: 20 },
    }] as any);
    const s = stubNotionFetch({
      dueSoonRows: ['duesoon-stale'], // a stale generated reminder to reconcile away
      allPagesRows: [],               // cleanup finds no pages → archives nothing itself
    });

    const result = JSON.parse(await TOOL.handler({ databaseId: 'db-1' }));
    expect(result.success).toBe(true);

    // The reconciliation ran and archived the stale reminder.
    expect(s.dueSoonQueried()).toBe(true);
    expect(s.archivedIds()).toContain('duesoon-stale');
  });

  it('does NOT re-PATCH the DB schema when the "Type" property already exists', async () => {
    // A redundant schema PATCH invalidates Notion's query index, so the very next
    // archive query misses existing Due Soon rows and duplicates pile up each sync.
    // When the property already exists we must skip the PATCH so archiving stays idempotent.
    enrollmentsMock.mockResolvedValue({
      Items: [{
        OrgUnit: { Id: 123, Name: 'Intro to CS', Code: 'CS135', Type: { Code: 'Course Offering' } },
        Access: { IsActive: true, CanAccess: true, StartDate: null, EndDate: null },
      }],
    } as any);
    dropboxMock.mockResolvedValue([{
      Id: 11, Name: 'Assignment 1', DueDate: '2026-09-20T23:59:00Z', Assessment: { ScoreDenominator: 20 },
    }] as any);
    const s = stubNotionFetch({
      dueSoonRows: ['duesoon-existing'],
      allPagesRows: [],
      typePropertyExists: true, // schema already has "Type"
    });

    const result = JSON.parse(await TOOL.handler({ databaseId: 'db-1' }));
    expect(result.success).toBe(true);
    // No schema PATCH issued, and the pre-existing Due Soon row was still archived.
    expect(s.schemaPatched()).toBe(false);
    expect(s.archivedIds()).toContain('duesoon-existing');
  });

  it('DOES create the "Type" property when it is missing (first sync)', async () => {
    enrollmentsMock.mockResolvedValue({
      Items: [{
        OrgUnit: { Id: 123, Name: 'Intro to CS', Code: 'CS135', Type: { Code: 'Course Offering' } },
        Access: { IsActive: true, CanAccess: true, StartDate: null, EndDate: null },
      }],
    } as any);
    dropboxMock.mockResolvedValue([{
      Id: 11, Name: 'Assignment 1', DueDate: '2026-09-20T23:59:00Z', Assessment: { ScoreDenominator: 20 },
    }] as any);
    const s = stubNotionFetch({ dueSoonRows: [], allPagesRows: [], typePropertyExists: false });

    const result = JSON.parse(await TOOL.handler({ databaseId: 'db-1' }));
    expect(result.success).toBe(true);
    expect(s.schemaPatched()).toBe(true);
  });

  it('surfaces a non-2xx Due Soon mutation without crashing the sync', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    enrollmentsMock.mockResolvedValue({
      Items: [{
        OrgUnit: { Id: 123, Name: 'Intro to CS', Code: 'CS135', Type: { Code: 'Course Offering' } },
        Access: { IsActive: true, CanAccess: true, StartDate: null, EndDate: null },
      }],
    } as any);
    dropboxMock.mockResolvedValue([{
      Id: 11, Name: 'Assignment 1', DueDate: '2026-09-20T23:59:00Z', Assessment: { ScoreDenominator: 20 },
    }] as any);
    // Authoritative sync, but archiving the stale reminder fails with 500.
    stubNotionFetch({ dueSoonRows: ['duesoon-stale'], archiveStatusById: { 'duesoon-stale': 500 } });

    const result = JSON.parse(await TOOL.handler({ databaseId: 'db-1' }));
    // The overall sync still succeeds…
    expect(result.success).toBe(true);
    // …and the Due Soon failure is surfaced via a logged error.
    const surfaced = errSpy.mock.calls.some((c) => String(c[0]).includes('Due Soon reconciliation failed'));
    expect(surfaced).toBe(true);
  });
});
