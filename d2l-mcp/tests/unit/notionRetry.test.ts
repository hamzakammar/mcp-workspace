/**
 * G6b: notionClient.ts — notionFetch retries 429 (honouring Retry-After) and 5xx
 * (idempotent only) with backoff; fetchAllChildren throws instead of returning a
 * partial list, so updateCoursePage aborts rather than appending a duplicate callout.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('../../src/utils/supabase.js', () => ({ supabase: { from: () => ({}) } }));

import {
  queryAllPages,
  updateCoursePage,
  createAssignmentPage,
  syncCourses,
  type CourseData,
} from '../../src/study/notionClient.js';

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  };
}

const course: CourseData = {
  orgUnitId: 1, name: 'Intro', code: 'CS135', isActive: true,
  assignments: [{ name: 'A1', dueDate: '2026-12-01T00:00:00Z', maxPoints: 10, status: 'Not Started' }],
  grades: [], announcements: [],
} as CourseData;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('notionFetch retry policy', () => {
  it('retries 429 honouring Retry-After seconds, then succeeds', async () => {
    const spy = vi.fn()
      .mockResolvedValueOnce(res(429, {}, { 'retry-after': '2' }))
      .mockResolvedValueOnce(res(200, { results: [], has_more: false }));
    vi.stubGlobal('fetch', spy);

    const p = queryAllPages('tok', 'db');
    await vi.advanceTimersByTimeAsync(1999);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBeInstanceOf(Map);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('retries 5xx with exponential backoff and gives up after 4 attempts', async () => {
    const spy = vi.fn().mockResolvedValue(res(503, { message: 'unavailable' }));
    vi.stubGlobal('fetch', spy);

    const p = queryAllPages('tok', 'db');
    const assertion = expect(p).rejects.toThrow(/503/);
    await vi.advanceTimersByTimeAsync(500);   // 1st backoff
    expect(spy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);  // 2nd backoff
    expect(spy).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2000);  // 3rd backoff
    await assertion;
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('does NOT retry 5xx on non-idempotent create (avoids duplicate pages) but does retry 429', async () => {
    const spy5 = vi.fn().mockResolvedValue(res(502, { message: 'bad gateway' }));
    vi.stubGlobal('fetch', spy5);
    await expect(createAssignmentPage('tok', 'db', { title: 'A', courseName: 'C', courseCode: 'C1', dueDate: null } as any))
      .rejects.toThrow(/502/);
    expect(spy5).toHaveBeenCalledTimes(1);

    const spy429 = vi.fn()
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(200, { id: 'p' }));
    vi.stubGlobal('fetch', spy429);
    const p = createAssignmentPage('tok', 'db', { title: 'A', courseName: 'C', courseCode: 'C1', dueDate: null } as any);
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toBeUndefined();
    expect(spy429).toHaveBeenCalledTimes(2);
  });

  it('does not retry 4xx other than 429', async () => {
    const spy = vi.fn().mockResolvedValue(res(400, { message: 'bad' }));
    vi.stubGlobal('fetch', spy);
    await expect(queryAllPages('tok', 'db')).rejects.toThrow(/400/);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('fetchAllChildren failure aborts the course update', () => {
  it('throws (no append, no delete) when listing page children keeps failing', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      calls.push({ url, method });
      if (method === 'GET' && url.includes('/children')) return res(500, { message: 'oops' });
      return res(200, {});
    }));

    const p = updateCoursePage('tok', 'page-1', structuredClone(course));
    const assertion = expect(p).rejects.toThrow(/list block children failed \(500\)/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('throws when a later page of children fails instead of returning a partial list', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      calls.push({ url, method });
      if (method === 'GET' && url.includes('/children')) {
        if (!url.includes('start_cursor')) return res(200, { results: [], has_more: true, next_cursor: 'c2' });
        return res(400, { message: 'bad cursor' });
      }
      return res(200, {});
    }));
    await expect(updateCoursePage('tok', 'page-1', structuredClone(course))).rejects.toThrow(/400/);
    expect(calls.some((c) => c.url.includes('/blocks/page-1/children') && c.method === 'PATCH')).toBe(false);
  });

  it('syncCourses counts the course as failed and continues', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (url.endsWith('/databases/db') && method === 'PATCH') return res(200, {});
      if (url.endsWith('/databases/db/query')) {
        return res(200, {
          results: [{ id: 'page-1', properties: { Name: { title: [{ plain_text: 'Intro' }] }, 'Course Code': { rich_text: [{ plain_text: 'CS135' }] } } }],
          has_more: false,
        });
      }
      if (method === 'GET' && url.includes('/children')) return res(404, { message: 'nf' });
      if (url.endsWith('/pages') && method === 'POST') return res(200, { id: 'new' });
      return res(200, {});
    }));
    const other = { ...structuredClone(course), code: 'CS136', name: 'Other' };
    const result = await syncCourses('tok', 'db', [structuredClone(course), other], { delayMs: 0 });
    expect(result).toEqual({ created: 1, updated: 0, failed: 1 });
  });
});
