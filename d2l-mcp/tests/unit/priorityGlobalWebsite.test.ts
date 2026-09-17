/**
 * Guards the dedup keys that let what_should_i_work_on_global merge website/outline-
 * derived tasks (from the `tasks` table) with live D2L items without double-listing the
 * same assessment.
 */
import { describe, it, expect } from 'vitest';
import { shortCode, assessmentDedupKey } from '../../src/tools/priorityGlobal.js';

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
