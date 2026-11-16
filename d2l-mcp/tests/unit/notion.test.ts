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
    getMySubmissions: vi.fn(),
    resolveHost: vi.fn(async () => 'learn.other.edu'),
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

afterEach(() => { vi.clearAllMocks(); });

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

describe('sync_to_notion — failed course pages', () => {
  it('reports a partial failure with a warning', async () => {
    syncMock.mockResolvedValue({ created: 1, updated: 0, failed: 1 });
    const r = JSON.parse(await TOOL.handler({ databaseId: 'db-1' }));
    expect(r.success).toBe(true);
    expect(r.partial).toBe(true);
    expect(r.warning).toMatch(/1 of 1 course page failed/);
  });

  it('returns success: false when every course page failed', async () => {
    syncMock.mockResolvedValue({ created: 0, updated: 0, failed: 1 });
    const r = JSON.parse(await TOOL.handler({ databaseId: 'db-1' }));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/failed to sync/);
  });

  it("builds D2L links from the user's resolved host", async () => {
    dropboxMock.mockResolvedValue([{ Id: 11, Name: 'Assignment 1', DueDate: null, Assessment: null }] as any);
    vi.mocked((client as any).getMySubmissions).mockResolvedValue([]);
    let courses: any[] = [];
    syncMock.mockImplementation(async (_t, _d, c) => { courses = c; return { created: 1, updated: 0, failed: 0 }; });
    await TOOL.handler({ databaseId: 'db-1' });
    expect(courses[0].assignments[0].url).toMatch(/^https:\/\/learn\.other\.edu\//);
  });
});
