/**
 * Unit tests for the sync_to_notion MCP tool handler.
 *
 * Tests the tool contract: error messages, D2L data mapping,
 * and sync result formatting. All external calls are mocked.
 *
 * Written FIRST (TDD) — implementation in src/tools/notion.ts.
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

// Mock notionClient so we can control sync behavior
vi.mock('../../src/study/notionClient.js', () => ({
  validateNotionToken: vi.fn(),
  syncAssignments: vi.fn(),
}));

// Mock the credential/token lookup
vi.mock('../../src/study/notionAuth.js', () => ({
  getNotionToken: vi.fn(),
}));

// Mock D2L client
vi.mock('../../src/client.js', () => ({
  client: {
    getMyEnrollments: vi.fn(),
    getDropboxFolders: vi.fn(),
    getGradeObjects: vi.fn(),
  },
}));

import { notionTools } from '../../src/tools/notion.js';
import { syncAssignments, validateNotionToken } from '../../src/study/notionClient.js';
import { getNotionToken } from '../../src/study/notionAuth.js';
import { client } from '../../src/client.js';

const syncMock = vi.mocked(syncAssignments);
const tokenMock = vi.mocked(getNotionToken);
const validateMock = vi.mocked(validateNotionToken);
const enrollmentsMock = vi.mocked(client.getMyEnrollments);
const dropboxMock = vi.mocked(client.getDropboxFolders);
const gradesMock = vi.mocked(client.getGradeObjects);

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

  it('returns error when D2L has no active enrollments', async () => {
    tokenMock.mockResolvedValue('secret_test');
    validateMock.mockResolvedValue(true);
    enrollmentsMock.mockResolvedValue({ Items: [] } as any);
    gradesMock.mockResolvedValue([]);
    syncMock.mockResolvedValue({ created: 0, updated: 0, failed: 0 });
    const result = JSON.parse(await TOOL.handler({ databaseId: 'db-1' }));
    // No courses → sync returns 0 items, but should succeed
    expect(result.success).toBe(true);
    expect(result.coursesChecked).toBe(0);
  });
});

// ─── Field mapping ─────────────────────────────────────────────────────────────

describe('sync_to_notion — field mapping', () => {
  beforeEach(() => {
    tokenMock.mockResolvedValue('secret_test');
    validateMock.mockResolvedValue(true);

    enrollmentsMock.mockResolvedValue({
      Items: [{
        OrgUnit: { Id: 123, Name: 'Intro to CS', Code: 'CS135', Type: { Code: 'Course Offering' } },
        Access: { IsActive: true, CanAccess: true, StartDate: null, EndDate: null },
      }],
    } as any);

    gradesMock.mockResolvedValue([]);
  });

  it('maps assignment title correctly', async () => {
    dropboxMock.mockResolvedValue([{
      Id: 1, Name: 'Assignment 1',
      DueDate: '2026-04-15T23:59:00Z',
      Assessment: { ScoreDenominator: 20 },
    }] as any);

    let capturedAssignments: any[] = [];
    syncMock.mockImplementation(async (_t, _db, assignments) => {
      capturedAssignments = assignments;
      return { created: 1, updated: 0, failed: 0 };
    });

    await TOOL.handler({ databaseId: 'db-1' });
    expect(capturedAssignments[0].title).toBe('Assignment 1');
  });

  it('maps courseCode correctly', async () => {
    dropboxMock.mockResolvedValue([{
      Id: 1, Name: 'Assignment 1',
      DueDate: '2026-04-15T23:59:00Z',
      Assessment: null,
    }] as any);

    let capturedAssignments: any[] = [];
    syncMock.mockImplementation(async (_t, _db, assignments) => {
      capturedAssignments = assignments;
      return { created: 1, updated: 0, failed: 0 };
    });

    await TOOL.handler({ databaseId: 'db-1' });
    expect(capturedAssignments[0].courseCode).toBe('CS135');
    expect(capturedAssignments[0].courseName).toBe('Intro to CS');
  });

  it('maps dueDate as ISO string', async () => {
    dropboxMock.mockResolvedValue([{
      Id: 1, Name: 'Lab 2',
      DueDate: '2026-05-01T23:59:00Z',
      Assessment: null,
    }] as any);

    let capturedAssignments: any[] = [];
    syncMock.mockImplementation(async (_t, _db, assignments) => {
      capturedAssignments = assignments;
      return { created: 1, updated: 0, failed: 0 };
    });

    await TOOL.handler({ databaseId: 'db-1' });
    expect(capturedAssignments[0].dueDate).toBe('2026-05-01T23:59:00Z');
  });

  it('maps type as "assignment" for dropbox folders', async () => {
    dropboxMock.mockResolvedValue([{
      Id: 1, Name: 'A1', DueDate: '2026-05-01T00:00:00Z', Assessment: null,
    }] as any);

    let capturedAssignments: any[] = [];
    syncMock.mockImplementation(async (_t, _db, assignments) => {
      capturedAssignments = assignments;
      return { created: 1, updated: 0, failed: 0 };
    });

    await TOOL.handler({ databaseId: 'db-1' });
    expect(capturedAssignments[0].type).toBe('assignment');
  });

  it('skips assignments with no due date', async () => {
    dropboxMock.mockResolvedValue([
      { Id: 1, Name: 'No Due Date', DueDate: null, Assessment: null },
      { Id: 2, Name: 'Has Due Date', DueDate: '2026-05-01T00:00:00Z', Assessment: null },
    ] as any);

    let capturedAssignments: any[] = [];
    syncMock.mockImplementation(async (_t, _db, assignments) => {
      capturedAssignments = assignments;
      return { created: assignments.length, updated: 0, failed: 0 };
    });

    await TOOL.handler({ databaseId: 'db-1' });
    expect(capturedAssignments).toHaveLength(1);
    expect(capturedAssignments[0].name).not.toBe('No Due Date');
  });
});

// ─── Summary format ──────────────────────────────────────────────────────────

describe('sync_to_notion — summary format', () => {
  beforeEach(() => {
    tokenMock.mockResolvedValue('secret_test');
    validateMock.mockResolvedValue(true);
    enrollmentsMock.mockResolvedValue({
      Items: [{
        OrgUnit: { Id: 1, Name: 'Intro to CS', Code: 'CS135', Type: { Code: 'Course Offering' } },
        Access: { IsActive: true, CanAccess: true, StartDate: null, EndDate: null },
      }],
    } as any);
    gradesMock.mockResolvedValue([]);
    dropboxMock.mockResolvedValue([
      { Id: 1, Name: 'A1', DueDate: '2026-05-01T00:00:00Z', Assessment: null },
    ] as any);
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

  it('summary mentions created count when items were synced', async () => {
    syncMock.mockResolvedValue({ created: 5, updated: 2, failed: 0 });
    const result = JSON.parse(await TOOL.handler({ databaseId: 'db-1' }));
    expect(result.summary).toMatch(/5/);
  });
});

// ─── Error resilience ────────────────────────────────────────────────────────

describe('sync_to_notion — error resilience', () => {
  it('returns error if syncAssignments throws (e.g. invalid database ID)', async () => {
    tokenMock.mockResolvedValue('secret_test');
    validateMock.mockResolvedValue(true);
    enrollmentsMock.mockResolvedValue({
      Items: [{
        OrgUnit: { Id: 1, Name: 'CS', Code: 'CS135', Type: { Code: 'Course Offering' } },
        Access: { IsActive: true, CanAccess: true, StartDate: null, EndDate: null },
      }],
    } as any);
    gradesMock.mockResolvedValue([]);
    dropboxMock.mockResolvedValue([
      { Id: 1, Name: 'A1', DueDate: '2026-05-01T00:00:00Z', Assessment: null },
    ] as any);
    syncMock.mockRejectedValue(new Error('Notion query failed (404): object_not_found'));

    const result = JSON.parse(await TOOL.handler({ databaseId: 'bad-db-id' }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/404|not_found|Notion/i);
  });
});
