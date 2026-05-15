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
    getMyGradeValues: vi.fn(),
    getNews: vi.fn(),
  },
}));

import { notionTools } from '../../src/tools/notion.js';
import { syncCourses } from '../../src/study/notionClient.js';
import { getNotionToken } from '../../src/study/notionAuth.js';
import { client } from '../../src/client.js';

const syncMock = vi.mocked(syncCourses);
const tokenMock = vi.mocked(getNotionToken);
const enrollmentsMock = vi.mocked(client.getMyEnrollments);
const dropboxMock = vi.mocked(client.getDropboxFolders);
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
    gradesMock.mockResolvedValue([]);
    newsMock.mockResolvedValue([]);
    syncMock.mockRejectedValue(new Error('Notion query failed (404): object_not_found'));

    const result = JSON.parse(await TOOL.handler({ databaseId: 'bad-db-id' }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/404|not_found|Notion/i);
  });
});
