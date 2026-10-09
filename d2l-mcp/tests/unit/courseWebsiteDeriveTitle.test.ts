import { describe, it, expect } from 'vitest';
import { deriveTitle } from '../../src/study/src/courseWebsite/parsers.js';

describe('deriveTitle', () => {
  it('strips the dangling separator left before "due"', () => {
    expect(deriveTitle('Assignment 1 (due Tue Sep 22 at 9pm)')).toBe('Assignment 1');
    expect(deriveTitle('A2 - due Oct 6')).toBe('A2');
    expect(deriveTitle('Project 1: due Nov 3, 11:59pm')).toBe('Project 1');
    expect(deriveTitle('Quiz 3 — due Friday')).toBe('Quiz 3');
  });

  it('leaves titles without a "due" clause intact', () => {
    expect(deriveTitle('Assignment 4 (Graphs)')).toBe('Assignment 4 (Graphs)');
  });
});
