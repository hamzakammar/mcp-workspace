/**
 * Outline search results: only an exact course + term match is accepted, so a
 * different term's outline is never cached as the current one.
 */
import { describe, it, expect } from 'vitest';
import { selectOutlineMatch } from '../../src/study/outlineClient.js';

const r = (term: string, courses: string, url = `/${term}/${courses}`) => ({ term, courses, title: courses, url });

describe('selectOutlineMatch', () => {
  it('returns the result for the exact course and term', () => {
    const results = [r('1265', 'CS 241'), r('1269', 'CS 241'), r('1269', 'CS 241E')];
    expect(selectOutlineMatch(results, 'CS241', '1269')).toBe(results[1]);
    expect(selectOutlineMatch(results, 'CS241E', '1269')).toBe(results[2]);
  });

  it('returns undefined (not results[0]) when the term is missing', () => {
    expect(selectOutlineMatch([r('1265', 'CS 241')], 'CS241', '1269')).toBeUndefined();
  });

  it('returns undefined when only a different course matches the term', () => {
    expect(selectOutlineMatch([r('1269', 'CS 2410')], 'CS241', '1269')).toBeUndefined();
    expect(selectOutlineMatch([r('1269', 'MATH 135')], 'CS135', '1269')).toBeUndefined();
  });

  it('accepts cross-listed courses', () => {
    const results = [r('1269', 'CS 135, MATH 135')];
    expect(selectOutlineMatch(results, 'MATH135', '1269')).toBe(results[0]);
    expect(selectOutlineMatch([r('1269', 'CS 135 MATH 135')], 'MATH135', '1269')).toBeDefined();
  });
});
