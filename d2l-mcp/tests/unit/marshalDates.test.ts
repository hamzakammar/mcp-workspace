import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatRelativeDate,
  isEntityDropboxSubmitted,
  marshalSubmissions,
  isCourseOfferingEnrollment,
  marshalEnrollments,
  isD2LNotFound,
  isQuizAttemptCompleted,
  loadQuizAttemptSummary,
  type RawSubmission,
} from '../../src/utils/marshal.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('formatRelativeDate — Toronto calendar days', () => {
  it('13h ahead but still the same local day is "today"', () => {
    vi.useFakeTimers();
    // 10:00 EST on Nov 16
    vi.setSystemTime(new Date('2026-11-16T15:00:00Z'));
    // 23:00 EST on Nov 16
    expect(formatRelativeDate('2026-11-17T04:00:00Z')).toBe('today');
  });

  it('1h ago but on the previous local day is "yesterday"', () => {
    vi.useFakeTimers();
    // 00:30 EST on Nov 16
    vi.setSystemTime(new Date('2026-11-16T05:30:00Z'));
    // 23:30 EST on Nov 15
    expect(formatRelativeDate('2026-11-16T04:30:00Z')).toBe('yesterday');
  });

  it('a few hours ahead past local midnight is "tomorrow"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T03:00:00Z')); // 22:00 EST Nov 16
    expect(formatRelativeDate('2026-11-17T06:00:00Z')).toBe('tomorrow'); // 01:00 EST Nov 17
  });

  it('counts days across a range and falls back to an absolute date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-16T15:00:00Z'));
    expect(formatRelativeDate('2026-11-19T15:00:00Z')).toBe('in 3 days');
    expect(formatRelativeDate('2026-11-11T15:00:00Z')).toBe('5 days ago');
    expect(formatRelativeDate('2026-12-25T15:00:00Z')).toMatch(/Dec/);
    expect(formatRelativeDate('not a date')).toBeNull();
  });
});

describe('submission status', () => {
  const base = { Entity: { DisplayName: 'Me' }, Feedback: null, CompletionDate: null };
  it('treats Submitted (1), Published (3) and non-empty Submissions[] as submitted', () => {
    expect(isEntityDropboxSubmitted({ Status: 1 })).toBe(true);
    expect(isEntityDropboxSubmitted({ Status: 3 })).toBe(true);
    expect(isEntityDropboxSubmitted({ Status: 0, Submissions: [{}] })).toBe(true);
    expect(isEntityDropboxSubmitted({ Status: 0, Submissions: [] })).toBe(false);
    expect(isEntityDropboxSubmitted({ Status: 2 })).toBe(false);
    expect(isEntityDropboxSubmitted(null)).toBe(false);
  });

  it('marshalSubmissions marks a Published entity as submitted', () => {
    const out = marshalSubmissions([{ ...base, Status: 3, Submissions: [] } as unknown as RawSubmission]);
    expect(out[0].submitted).toBe(true);
  });
});

describe('course-offering filter', () => {
  it('accepts Type.Id 3 or the Course Offering code', () => {
    expect(isCourseOfferingEnrollment({ OrgUnit: { Type: { Id: 3, Code: 'x' } } })).toBe(true);
    expect(isCourseOfferingEnrollment({ OrgUnit: { Type: { Code: 'Course Offering' } } })).toBe(true);
    expect(isCourseOfferingEnrollment({ OrgUnit: { Type: { Id: 2, Code: 'Department' } } })).toBe(false);
    expect(isCourseOfferingEnrollment({})).toBe(false);
  });

  it('marshalEnrollments keeps only course offerings', () => {
    const mk = (id: number, typeId: number, code: string) => ({
      OrgUnit: { Id: id, Type: { Id: typeId, Code: code, Name: code }, Name: `n${id}`, Code: `c${id}`, HomeUrl: '' },
      Access: { IsActive: true, CanAccess: true, LastAccessed: null },
    });
    const out = marshalEnrollments({ Items: [mk(1, 3, 'Course Offering'), mk(2, 5, 'Semester')] as any });
    expect(out.map((c) => c.id)).toEqual([1]);
  });
});

describe('quiz attempts', () => {
  it('detects 404s from D2LApiError-like objects and messages', () => {
    expect(isD2LNotFound({ status: 404 })).toBe(true);
    expect(isD2LNotFound({ status: 403 })).toBe(false);
    expect(isD2LNotFound(new Error('D2L API error 404: nope'))).toBe(true);
    expect(isD2LNotFound(new Error('D2L API error 500: boom'))).toBe(false);
  });

  it('uses Valence Completed timestamps', () => {
    expect(isQuizAttemptCompleted({ Completed: '2026-11-01T00:00:00Z' })).toBe(true);
    expect(isQuizAttemptCompleted({ Completed: null, Started: '2026-11-01T00:00:00Z' })).toBe(false);
    expect(isQuizAttemptCompleted({ IsCompleted: true })).toBe(true);
  });

  it('404 → zero attempts; other errors → unknown; success counts completed', async () => {
    expect(await loadQuizAttemptSummary(async () => { throw Object.assign(new Error('D2L API error 404: x'), { status: 404 }); }))
      .toEqual({ attempts: [], completed: 0, unknown: false });
    const err = await loadQuizAttemptSummary(async () => { throw Object.assign(new Error('D2L API error 403: x'), { status: 403 }); });
    expect(err.unknown).toBe(true);
    const ok = await loadQuizAttemptSummary(async () => ({
      Objects: [{ Completed: '2026-11-01T00:00:00Z' }, { Completed: null }],
      Next: null,
    }));
    expect(ok).toMatchObject({ completed: 1, unknown: false });
  });
});
