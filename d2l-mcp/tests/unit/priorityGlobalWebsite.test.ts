/**
 * Guards the dedup keys that let what_should_i_work_on_global merge website/outline-
 * derived tasks (from the `tasks` table) with live D2L items without double-listing the
 * same assessment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  shortCode,
  assessmentDedupKey,
  assessmentKind,
  dueClause,
  connectorTasksToRecommendations,
  hasDropboxSubmission,
  matchGradeWeight,
} from '../../src/tools/priorityGlobal.js';

describe('shortCode', () => {
  it('extracts the bare course code from messy D2L codes and names', () => {
    expect(shortCode('CS241_1269')).toBe('CS241');
    expect(shortCode('CS 241 - Fall 2026')).toBe('CS241');
    expect(shortCode('SE212_nday_1269')).toBe('SE212');
    expect(shortCode('CS241')).toBe('CS241');
  });
});

describe('assessmentDedupKey', () => {
  it('collapses website "Assignment 1" with D2L "A1" in the same course', () => {
    expect(assessmentDedupKey('CS241', 'Assignment 1'))
      .toBe(assessmentDedupKey('CS241_1269', 'A1'));
  });

  it('keeps different assignment numbers distinct', () => {
    expect(assessmentDedupKey('CS241', 'Assignment 1'))
      .not.toBe(assessmentDedupKey('CS241', 'Assignment 2'));
  });

  it('keeps the same number in different courses distinct', () => {
    expect(assessmentDedupKey('CS241', 'Assignment 1'))
      .not.toBe(assessmentDedupKey('SE212', 'Assignment 1'));
  });

  it('falls back to the cleaned name when there is no number', () => {
    expect(assessmentDedupKey('CS241', 'Final Project'))
      .toBe(assessmentDedupKey('CS241_1269', 'final   project'));
  });
});

describe('assessmentDedupKey — type-aware', () => {
  it('keeps "Quiz 1" and "Assignment 1" in the same course distinct', () => {
    expect(assessmentDedupKey('CS241', 'Quiz 1')).not.toBe(assessmentDedupKey('CS241', 'Assignment 1'));
    expect(assessmentDedupKey('CS241', 'Project 1')).not.toBe(assessmentDedupKey('CS241', 'A1'));
  });

  it('still collapses same-type aliases', () => {
    expect(assessmentDedupKey('CS241', 'Asn 2')).toBe(assessmentDedupKey('CS241', 'Assignment 2'));
    expect(assessmentDedupKey('CS241', 'P1')).toBe(assessmentDedupKey('CS241', 'Project 1'));
  });
});

describe('assessmentKind', () => {
  it('classifies common names', () => {
    expect(assessmentKind('A1')).toBe('assignment');
    expect(assessmentKind('Assignment 3')).toBe('assignment');
    expect(assessmentKind('Quiz2')).toBe('quiz');
    expect(assessmentKind('Midterm 1')).toBe('midterm');
    expect(assessmentKind('Final Exam')).toBe('exam');
    expect(assessmentKind('Final Project')).toBe('project');
    expect(assessmentKind('Lab3')).toBe('lab');
    expect(assessmentKind('Laboratory 3')).toBe('lab');
    expect(assessmentKind('Reading reflection')).toBeNull();
  });
});

describe('matchGradeWeight (global) — tier-2 requires same type', () => {
  it('does not match "Assignment 1" to "Midterm 1"', () => {
    expect(matchGradeWeight('Assignment 1', [{ Id: 1, Name: 'Midterm 1', Weight: 25 }])).toBeNull();
  });
  it('still matches "A1" to "Assignment 1"', () => {
    expect(matchGradeWeight('A1', [{ Id: 1, Name: 'Assignment 1', Weight: 10 }])).toBe(10);
  });
});

describe('connectorTasksToRecommendations', () => {
  const NOW = new Date('2026-10-09T12:00:00Z').getTime();
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('excludes already-past-due connector items (status unknown — never rank them #1)', () => {
    const recs = connectorTasksToRecommendations(
      [
        { courseCode: 'CS241', title: 'Assignment 1', dueAt: '2026-10-08T03:59:00Z' }, // past
        { courseCode: 'CS241', title: 'Assignment 2', dueAt: '2026-10-11T03:59:00Z' }, // future
      ],
      new Set(),
      (t) => t.courseCode,
      NOW,
    );
    expect(recs.map((r) => r.name)).toEqual(['Assignment 2']);
    expect(recs[0].reason).toBe('From course website/outline, due in 2 days');
    expect(recs[0].reason).not.toMatch(/overdue/);
  });

  it("uses the item's real type and dedups against seen keys", () => {
    const seen = new Set([assessmentDedupKey('CS241', 'A1')]);
    const recs = connectorTasksToRecommendations(
      [
        { courseCode: 'CS241', title: 'Assignment 1', dueAt: '2026-10-11T03:59:00Z' }, // dup of D2L A1
        { courseCode: 'CS241', title: 'Quiz 1', dueAt: '2026-10-11T03:59:00Z' },       // distinct
        { courseCode: 'CS241', title: 'Midterm', dueAt: '2026-10-12T03:59:00Z' },
      ],
      seen,
      (t) => t.courseCode,
      NOW,
    );
    expect(recs.map((r) => [r.name, r.type])).toEqual([['Quiz 1', 'quiz'], ['Midterm', 'midterm']]);
  });
});

describe('dueClause', () => {
  const NOW = new Date('2026-10-09T12:00:00Z').getTime();
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('never produces "due in overdue"', () => {
    expect(dueClause('2026-10-08T12:00:00Z')).toBe('overdue');
    expect(dueClause('2026-10-08T12:00:00Z', true)).toBe('Overdue');
    expect(dueClause('2026-10-10T12:00:00Z')).toBe('due in 1 day');
    expect(dueClause('2026-10-10T12:00:00Z', true)).toBe('Due in 1 day');
  });
});

describe('hasDropboxSubmission', () => {
  it('reads both D2L response shapes', () => {
    expect(hasDropboxSubmission([])).toBe(false);
    expect(hasDropboxSubmission([{ Id: 1 }])).toBe(true);
    expect(hasDropboxSubmission({ HasSubmission: true })).toBe(true);
    expect(hasDropboxSubmission({ Submissions: [{}] })).toBe(true);
    expect(hasDropboxSubmission({ Submissions: [] })).toBe(false);
    expect(hasDropboxSubmission(null)).toBe(false);
  });
});
