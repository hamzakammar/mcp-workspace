/**
 * Unit tests for priority scoring helpers.
 *
 * These functions are the core decision engine — if urgency scoring breaks,
 * users get wrong priorities. Tests cover every branch and edge case.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  urgencyScore,
  matchGradeWeight,
  formatDueIn,
  type RawGradeObject,
} from '../../src/tools/priority.js';

// ─── urgencyScore ─────────────────────────────────────────────────────────────

describe('urgencyScore', () => {
  const NOW = new Date('2026-05-07T12:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('higher weight produces higher score (same due time)', () => {
    const dueMs = NOW + 24 * 60 * 60 * 1000; // 24h from now
    const low = urgencyScore(dueMs, 10, true);
    const high = urgencyScore(dueMs, 30, true);
    expect(high).toBeGreaterThan(low);
  });

  it('closer due date produces higher score (same weight)', () => {
    const close = urgencyScore(NOW + 2 * 60 * 60 * 1000, 20, true);  // 2h
    const far   = urgencyScore(NOW + 48 * 60 * 60 * 1000, 20, true); // 48h
    expect(close).toBeGreaterThan(far);
  });

  it('not-started penalty doubles the score vs started', () => {
    const dueMs = NOW + 10 * 60 * 60 * 1000; // 10h
    const notStarted = urgencyScore(dueMs, 20, true);
    const started    = urgencyScore(dueMs, 20, false);
    expect(notStarted).toBeCloseTo(started * 2);
  });

  it('null weight falls back to 0.1 (10%) default', () => {
    const dueMs = NOW + 24 * 60 * 60 * 1000;
    const withNull    = urgencyScore(dueMs, null, false);
    const withDefault = urgencyScore(dueMs, 10, false);
    expect(withNull).toBeCloseTo(withDefault);
  });

  it('clamps hoursUntilDue to 0.1 when already overdue to prevent division blow-up', () => {
    const overdue = NOW - 60 * 60 * 1000; // 1h ago
    const score = urgencyScore(overdue, 20, true);
    // formula: (0.2 * 2) / 0.1 = 4.0
    expect(score).toBeCloseTo(4.0);
    expect(isFinite(score)).toBe(true);
  });

  it('clamps hoursUntilDue to 0.1 when due in 1 second (near-zero)', () => {
    const almostDue = NOW + 1000; // 1 second
    const score = urgencyScore(almostDue, 20, true);
    expect(isFinite(score)).toBe(true);
    expect(score).toBeGreaterThan(0);
  });

  it('produces correct value: weight=20%, 24h, not started', () => {
    const dueMs = NOW + 24 * 60 * 60 * 1000;
    // formula: (0.20 * 2) / 24 ≈ 0.01667
    expect(urgencyScore(dueMs, 20, true)).toBeCloseTo(0.01667, 4);
  });

  it('produces correct value: weight=10%, 1h, started', () => {
    const dueMs = NOW + 1 * 60 * 60 * 1000;
    // formula: (0.10 * 1) / 1 = 0.10
    expect(urgencyScore(dueMs, 10, false)).toBeCloseTo(0.10);
  });
});

// ─── matchGradeWeight ─────────────────────────────────────────────────────────

describe('matchGradeWeight', () => {
  function makeGrades(entries: Array<[string, number | null]>): RawGradeObject[] {
    return entries.map(([name, weight], i) => ({ Id: i + 1, Name: name, Weight: weight }));
  }

  // ── Tier 1: string containment ──────────────────────────────────────────────

  it('exact name match (case-insensitive)', () => {
    const grades = makeGrades([['Assignment 1', 15]]);
    expect(matchGradeWeight('Assignment 1', grades)).toBe(15);
    expect(matchGradeWeight('assignment 1', grades)).toBe(15);
    expect(matchGradeWeight('ASSIGNMENT 1', grades)).toBe(15);
  });

  it('grade object name is substring of assignment name', () => {
    // D2L grade: "A1", dropbox folder: "A1 - Linked Lists Report"
    const grades = makeGrades([['A1', 10]]);
    expect(matchGradeWeight('A1 - Linked Lists Report', grades)).toBe(10);
  });

  it('assignment name is substring of grade object name', () => {
    // dropbox: "Midterm", grade object: "Midterm Exam"
    const grades = makeGrades([['Midterm Exam', 25]]);
    expect(matchGradeWeight('Midterm', grades)).toBe(25);
  });

  it('returns null when Weight field is null (grade object exists but unweighted)', () => {
    const grades = makeGrades([['Assignment 1', null]]);
    expect(matchGradeWeight('Assignment 1', grades)).toBeNull();
  });

  it('returns null when no grade object matches at all', () => {
    const grades = makeGrades([['Quiz 1', 5], ['Quiz 2', 5]]);
    expect(matchGradeWeight('Final Exam', grades)).toBeNull();
  });

  it('returns null for empty grade objects array', () => {
    expect(matchGradeWeight('Assignment 1', [])).toBeNull();
  });

  // ── Tier 2: number-extraction fallback ──────────────────────────────────────

  it('tier-2: "A1" matches "Assignment 1" via shared integer 1', () => {
    const grades = makeGrades([['Assignment 1', 10]]);
    expect(matchGradeWeight('A1', grades)).toBe(10);
  });

  it('tier-2: "Quiz2" matches "Quiz 2" via shared integer 2', () => {
    const grades = makeGrades([['Quiz 2', 8]]);
    expect(matchGradeWeight('Quiz2', grades)).toBe(8);
  });

  it('tier-2: "Lab3" matches "Laboratory 3" via shared integer 3', () => {
    const grades = makeGrades([['Laboratory 3', 6]]);
    expect(matchGradeWeight('Lab3', grades)).toBe(6);
  });

  it('tier-2: no false positive — "Assignment 10" does not match "Assignment 1"', () => {
    // "10" ≠ "1" — should not match
    const grades = makeGrades([['Assignment 1', 10]]);
    expect(matchGradeWeight('Assignment 10', grades)).toBeNull();
  });

  it('tier-2: no false positive — "A1" does not match "Assignment 10"', () => {
    // "1" ≠ "10"
    const grades = makeGrades([['Assignment 10', 10]]);
    expect(matchGradeWeight('A1', grades)).toBeNull();
  });

  it('tier-1 takes priority over tier-2 (uses first match found)', () => {
    // "Assignment 1" exact-matches grade object 1, not grade object 11
    const grades = makeGrades([['Assignment 1', 10], ['Assignment 11', 20]]);
    expect(matchGradeWeight('Assignment 1', grades)).toBe(10);
  });
});

// ─── formatDueIn ─────────────────────────────────────────────────────────────

describe('formatDueIn', () => {
  const NOW = new Date('2026-05-07T12:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('past date returns "overdue"', () => {
    const past = new Date(NOW - 60 * 60 * 1000).toISOString(); // 1h ago
    expect(formatDueIn(past)).toBe('overdue');
  });

  it('exactly now (diffMs=0) returns "overdue"', () => {
    expect(formatDueIn(new Date(NOW).toISOString())).toBe('overdue');
  });

  it('45 minutes from now rounds to "1 hour"', () => {
    const t = new Date(NOW + 45 * 60 * 1000).toISOString();
    expect(formatDueIn(t)).toBe('1 hour');
  });

  it('90 minutes from now rounds to "2 hours"', () => {
    const t = new Date(NOW + 90 * 60 * 1000).toISOString();
    expect(formatDueIn(t)).toBe('2 hours');
  });

  it('12 hours returns "12 hours"', () => {
    const t = new Date(NOW + 12 * 60 * 60 * 1000).toISOString();
    expect(formatDueIn(t)).toBe('12 hours');
  });

  it('exactly 24 hours rolls over to "1 day"', () => {
    const t = new Date(NOW + 24 * 60 * 60 * 1000).toISOString();
    expect(formatDueIn(t)).toBe('1 day');
  });

  it('36 hours returns "2 days"', () => {
    const t = new Date(NOW + 36 * 60 * 60 * 1000).toISOString();
    expect(formatDueIn(t)).toBe('2 days');
  });

  it('singular vs plural: "1 hour" not "1 hours", "1 day" not "1 days"', () => {
    const oneHour = new Date(NOW + 60 * 60 * 1000).toISOString();
    const oneDay  = new Date(NOW + 24 * 60 * 60 * 1000).toISOString();
    expect(formatDueIn(oneHour)).toBe('1 hour');
    expect(formatDueIn(oneDay)).toBe('1 day');
  });
});
