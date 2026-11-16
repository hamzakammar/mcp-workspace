import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/client.js', () => ({
  client: {
    getGradeObjects: vi.fn(),
    getDropboxFolders: vi.fn(),
    getQuizzes: vi.fn(),
    getQuizAttempts: vi.fn(),
    getMySubmissions: vi.fn(),
    getMyEnrollments: vi.fn(),
  },
}));
vi.mock('../../src/utils/userContext.js', () => ({ getUserId: vi.fn(() => 'legacy') }));
vi.mock('../../src/study/src/courseWebsite/store.js', () => ({ loadUpcomingConnectorTasks: vi.fn(async () => []) }));

import { client } from '../../src/client.js';
import { priorityTools } from '../../src/tools/priority.js';
import { filterOutSubmitted } from '../../src/tools/priorityGlobal.js';

const c = vi.mocked(client);
const NOW = new Date('2026-11-16T15:00:00Z').getTime();
const iso = (hours: number) => new Date(NOW + hours * 3600_000).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  for (const f of Object.values(c)) (f as any).mockReset();
  c.getGradeObjects.mockResolvedValue([]);
  c.getDropboxFolders.mockResolvedValue([]);
  c.getQuizzes.mockResolvedValue({ Objects: [], Next: null });
  c.getMySubmissions.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

async function run(hoursAhead = 72) {
  return JSON.parse(await priorityTools.what_should_i_work_on.handler({ orgUnitId: 1, hoursAhead }));
}

describe('what_should_i_work_on ranking', () => {
  it('drops past-due quizzes', async () => {
    c.getQuizzes.mockResolvedValue({
      Objects: [
        { QuizId: 1, Name: 'Quiz Past', DueDate: iso(-2), AttemptsAllowed: null },
        { QuizId: 2, Name: 'Quiz Soon', DueDate: iso(5), AttemptsAllowed: null },
      ],
      Next: null,
    });
    c.getQuizAttempts.mockResolvedValue({ Objects: [], Next: null });
    const out = await run();
    expect(out.recommendations.map((r: any) => r.name)).toEqual(['Quiz Soon']);
  });

  it('filters submitted assignments before taking the top 5', async () => {
    // 6 submitted (most urgent) + 2 unsubmitted (less urgent)
    const folders = [
      ...Array.from({ length: 6 }, (_, i) => ({ Id: 100 + i, Name: `Done ${i}`, DueDate: iso(1 + i), Assessment: null })),
      { Id: 200, Name: 'Todo A', DueDate: iso(40), Assessment: null },
      { Id: 201, Name: 'Todo B', DueDate: iso(50), Assessment: null },
    ];
    c.getDropboxFolders.mockResolvedValue(folders);
    c.getMySubmissions.mockImplementation(async (_o: number, folderId: number) =>
      folderId < 200 ? [{ Status: 1, Submissions: [{ Id: 1 }] }] : [{ Status: 0, Submissions: [] }],
    );
    const out = await run();
    expect(out.recommendations.map((r: any) => r.name)).toEqual(['Todo A', 'Todo B']);
  });

  it('surfaces unknown attempt status instead of claiming 0', async () => {
    c.getQuizzes.mockResolvedValue({ Objects: [{ QuizId: 3, Name: 'Quiz X', DueDate: iso(5), AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 1 } }], Next: null });
    c.getQuizAttempts.mockRejectedValue(Object.assign(new Error('D2L API error 403: no'), { status: 403 }));
    const out = await run();
    expect(out.recommendations[0].reason).toMatch(/attempt status unknown/);
  });

  it('treats a 404 from attempts as zero attempts', async () => {
    c.getQuizzes.mockResolvedValue({ Objects: [{ QuizId: 3, Name: 'Quiz Y', DueDate: iso(5), AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 2 } }], Next: null });
    c.getQuizAttempts.mockRejectedValue(Object.assign(new Error('D2L API error 404: none'), { status: 404 }));
    const out = await run();
    expect(out.recommendations[0].reason).toMatch(/0 of 2 attempts used/);
  });
});

describe('filterOutSubmitted', () => {
  it('keeps items without a check and items whose check fails', async () => {
    const out = await filterOutSubmitted([1, 2, 3, 4], (n) =>
      n === 1 ? null : n === 2 ? Promise.resolve(true) : n === 3 ? Promise.reject(new Error('x')) : Promise.resolve(false),
    );
    expect(out).toEqual([1, 3, 4]);
  });

  it('stops at limit and makes at most maxChecks checks', async () => {
    const check = vi.fn(async (_n: number) => true); // everything "submitted"
    const out = await filterOutSubmitted([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], check, { limit: 2, maxChecks: 4, concurrency: 2 });
    expect(check).toHaveBeenCalledTimes(4);
    // items past the check budget are kept unchecked
    expect(out).toEqual([5, 6]);
  });

  it('defaults maxChecks to 3×limit', async () => {
    const check = vi.fn(async (_n: number) => true);
    await filterOutSubmitted(Array.from({ length: 50 }, (_, i) => i), check, { limit: 5 });
    expect(check).toHaveBeenCalledTimes(15);
  });
});
