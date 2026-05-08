/**
 * Unit tests for marshal.ts utility functions.
 *
 * These functions convert raw D2L API responses to LLM-friendly JSON.
 * They are pure (no I/O), so testing is straightforward. Coverage focuses on
 * edge cases that cause silent data loss: HTML with tricky entities, missing
 * fields, zero-length arrays, and relative date boundary conditions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  stripHtml,
  formatDate,
  formatRelativeDate,
  formatFileSize,
  removeEmpty,
  marshalGrades,
  marshalAnnouncements,
  marshalEnrollments,
  type RawGrade,
  type RawAnnouncement,
  type RawEnrollment,
} from '../../src/utils/marshal.js';

// ─── stripHtml ────────────────────────────────────────────────────────────────

describe('stripHtml', () => {
  it('strips basic HTML tags', () => {
    expect(stripHtml('<b>Hello</b>')).toBe('Hello');
  });

  it('strips nested tags', () => {
    expect(stripHtml('<p><strong>Submit</strong> by Friday.</p>')).toBe('Submit by Friday.');
  });

  it('decodes &amp; entity', () => {
    expect(stripHtml('CS &amp; Math')).toBe('CS & Math');
  });

  it('decodes &lt; and &gt; entities', () => {
    expect(stripHtml('if x &lt; y &gt; z')).toBe('if x < y > z');
  });

  it('decodes &quot; entity', () => {
    expect(stripHtml('He said &quot;hello&quot;')).toBe('He said "hello"');
  });

  it('decodes &nbsp; to a regular space', () => {
    expect(stripHtml('word&nbsp;word')).toBe('word word');
  });

  it('decodes &#39; to apostrophe', () => {
    expect(stripHtml('it&#39;s here')).toBe("it's here");
  });

  it('returns empty string for null input', () => {
    expect(stripHtml(null)).toBe('');
  });

  it('returns empty string for undefined input', () => {
    expect(stripHtml(undefined)).toBe('');
  });

  it('returns empty string for empty string input', () => {
    expect(stripHtml('')).toBe('');
  });

  it('returns plain text unchanged', () => {
    expect(stripHtml('No tags here')).toBe('No tags here');
  });

  it('collapses 3+ consecutive newlines to double newline', () => {
    const result = stripHtml('Line1\n\n\n\nLine2');
    expect(result).toBe('Line1\n\nLine2');
  });
});

// ─── formatFileSize ───────────────────────────────────────────────────────────

describe('formatFileSize', () => {
  it('formats bytes under 1 KB as "X B"', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1)).toBe('1 B');
  });

  it('formats bytes in KB range', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(2048)).toBe('2.0 KB');
  });

  it('formats bytes in MB range', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });
});

// ─── removeEmpty ─────────────────────────────────────────────────────────────

describe('removeEmpty', () => {
  it('removes null values', () => {
    const result = removeEmpty({ a: 'hello', b: null });
    expect(result).not.toHaveProperty('b');
    expect(result).toHaveProperty('a', 'hello');
  });

  it('removes undefined values', () => {
    const result = removeEmpty({ a: 'hello', b: undefined });
    expect(result).not.toHaveProperty('b');
  });

  it('removes empty strings', () => {
    const result = removeEmpty({ a: 'hello', b: '' });
    expect(result).not.toHaveProperty('b');
  });

  it('removes empty arrays', () => {
    const result = removeEmpty({ a: 'hello', b: [] });
    expect(result).not.toHaveProperty('b');
  });

  it('keeps non-empty arrays', () => {
    const result = removeEmpty({ a: [1, 2, 3] });
    expect(result).toHaveProperty('a');
  });

  it('keeps zero and false (falsy-but-valid values)', () => {
    const result = removeEmpty({ a: 0, b: false });
    expect(result).toHaveProperty('a', 0);
    expect(result).toHaveProperty('b', false);
  });
});

// ─── formatRelativeDate ───────────────────────────────────────────────────────

describe('formatRelativeDate', () => {
  const BASE = new Date('2026-05-07T12:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for null input', () => {
    expect(formatRelativeDate(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(formatRelativeDate(undefined)).toBeNull();
  });

  it('returns "today" for same-day date', () => {
    const today = new Date(BASE.getTime() + 2 * 60 * 60 * 1000).toISOString(); // 2h from now
    expect(formatRelativeDate(today)).toBe('today');
  });

  it('returns "tomorrow" for a date 1 day away', () => {
    const tomorrow = new Date(BASE.getTime() + 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeDate(tomorrow)).toBe('tomorrow');
  });

  it('returns "yesterday" for 1 day ago', () => {
    const yesterday = new Date(BASE.getTime() - 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeDate(yesterday)).toBe('yesterday');
  });

  it('returns "in X days" for 2–7 days ahead', () => {
    const threeDays = new Date(BASE.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeDate(threeDays)).toBe('in 3 days');
  });

  it('returns "X days ago" for 2–7 days past', () => {
    const fiveDaysAgo = new Date(BASE.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeDate(fiveDaysAgo)).toBe('5 days ago');
  });

  it('returns a formatted date string for dates > 7 days away', () => {
    const distant = new Date(BASE.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const result = formatRelativeDate(distant);
    // Should be a real date string, not a relative phrase
    expect(result).toBeTruthy();
    expect(result).not.toMatch(/^in \d+ days$/);
  });
});

// ─── marshalGrades ────────────────────────────────────────────────────────────

describe('marshalGrades', () => {
  it('formats score as "numerator/denominator"', () => {
    const raw: RawGrade[] = [{
      GradeObjectName: 'Assignment 1',
      PointsNumerator: 18,
      PointsDenominator: 20,
      DisplayedGrade: '90%',
      Comments: undefined,
      LastModified: null,
    }];
    const result = marshalGrades(raw);
    expect(result[0].score).toBe('18/20');
    expect(result[0].percentage).toBe('90%');
  });

  it('sets score to null when either numerator or denominator is null', () => {
    const raw: RawGrade[] = [{
      GradeObjectName: 'Ungraded',
      PointsNumerator: null,
      PointsDenominator: 20,
      DisplayedGrade: null,
      LastModified: null,
    }];
    const result = marshalGrades(raw);
    expect(result[0].score).toBeUndefined(); // removeEmpty strips null
  });

  it('includes feedback from Comments.Text', () => {
    const raw: RawGrade[] = [{
      GradeObjectName: 'Quiz 1',
      PointsNumerator: 9,
      PointsDenominator: 10,
      DisplayedGrade: '90%',
      Comments: { Text: 'Well done', Html: '<p>Well done</p>' },
      LastModified: null,
    }];
    const result = marshalGrades(raw);
    expect(result[0].feedback).toBe('Well done');
  });

  it('omits feedback when Comments is undefined', () => {
    const raw: RawGrade[] = [{
      GradeObjectName: 'Quiz 1',
      PointsNumerator: 9,
      PointsDenominator: 10,
      DisplayedGrade: '90%',
      Comments: undefined,
      LastModified: null,
    }];
    const result = marshalGrades(raw);
    expect(result[0].feedback).toBeUndefined();
  });

  it('returns empty array for empty input', () => {
    expect(marshalGrades([])).toEqual([]);
  });
});

// ─── marshalAnnouncements ─────────────────────────────────────────────────────

describe('marshalAnnouncements', () => {
  function makeAnnouncement(overrides: Partial<RawAnnouncement> = {}): RawAnnouncement {
    return {
      Id: 1,
      Title: 'Important Update',
      Body: { Text: 'Please read this.', Html: '<p>Please read this.</p>' },
      CreatedDate: '2026-05-06T10:00:00Z',
      StartDate: null,
      Attachments: [],
      IsPublished: true,
      ...overrides,
    };
  }

  it('strips HTML from announcement body', () => {
    const result = marshalAnnouncements([
      makeAnnouncement({ Body: { Text: '', Html: '<b>Bold text</b> here' } }),
    ]);
    expect(result[0].body).toBe('Bold text here');
  });

  it('prefers plain text body over HTML', () => {
    const result = marshalAnnouncements([
      makeAnnouncement({ Body: { Text: 'Plain text', Html: '<b>Bold</b>' } }),
    ]);
    expect(result[0].body).toBe('Plain text');
  });

  it('includes attachment info when present', () => {
    const result = marshalAnnouncements([
      makeAnnouncement({ Attachments: [{ FileName: 'syllabus.pdf', Size: 1024 * 100 }] }),
    ]);
    expect(result[0].attachments).toHaveLength(1);
    expect(result[0].attachments![0].name).toBe('syllabus.pdf');
  });

  it('omits attachments field when none are present', () => {
    const result = marshalAnnouncements([makeAnnouncement({ Attachments: [] })]);
    expect(result[0].attachments).toBeUndefined();
  });
});

// ─── marshalEnrollments ───────────────────────────────────────────────────────

describe('marshalEnrollments', () => {
  function makeCourse(overrides: {
    id?: number;
    name?: string;
    code?: string;
    typeCode?: string;
    isActive?: boolean;
    canAccess?: boolean;
  } = {}): RawEnrollment {
    return {
      OrgUnit: {
        Id: overrides.id ?? 123456,
        Type: { Code: overrides.typeCode ?? 'Course Offering', Name: 'Course' },
        Name: overrides.name ?? 'Introduction to CS',
        Code: overrides.code ?? 'CS135_S26',
        HomeUrl: 'https://learn.uwaterloo.ca/d2l/home/123456',
      },
      Access: {
        IsActive: overrides.isActive ?? true,
        CanAccess: overrides.canAccess ?? true,
        LastAccessed: null,
      },
    };
  }

  it('returns courses of type "Course Offering"', () => {
    const result = marshalEnrollments({
      Items: [makeCourse(), makeCourse({ typeCode: 'Department' })],
    });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('Course');
  });

  it('filters out non-course-offering types (e.g. Department, Organization)', () => {
    const result = marshalEnrollments({
      Items: [
        makeCourse({ typeCode: 'Department' }),
        makeCourse({ typeCode: 'Organization' }),
      ],
    });
    expect(result).toHaveLength(0);
  });

  it('preserves isActive and canAccess flags', () => {
    const result = marshalEnrollments({
      Items: [makeCourse({ isActive: false, canAccess: false })],
    });
    expect(result[0].isActive).toBe(false);
    expect(result[0].canAccess).toBe(false);
  });

  it('returns the correct course ID', () => {
    const result = marshalEnrollments({ Items: [makeCourse({ id: 999999 })] });
    expect(result[0].id).toBe(999999);
  });

  it('returns empty array for empty enrollment list', () => {
    expect(marshalEnrollments({ Items: [] })).toEqual([]);
  });
});
