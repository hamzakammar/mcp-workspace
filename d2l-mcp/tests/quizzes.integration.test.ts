/**
 * Task 2 — get_quizzes integration test
 * Requires D2L_INTEGRATION_TESTS=true and a valid session.
 */

import { describe, it, expect } from 'vitest';

const RUN = process.env.D2L_INTEGRATION_TESTS === 'true';
const ECE124 = 1221444;

describe.skipIf(!RUN)('get_quizzes (Task 2)', () => {
  it('returns an array for ECE 124', async () => {
    const { quizTools } = await import('../src/tools/quizzes.js');
    const raw = await quizTools.get_quizzes.handler({ orgUnitId: ECE124 });
    const result = JSON.parse(raw);
    expect(Array.isArray(result)).toBe(true);
  });

  it('each quiz has quizId and name', async () => {
    const { quizTools } = await import('../src/tools/quizzes.js');
    const raw = await quizTools.get_quizzes.handler({ orgUnitId: ECE124 });
    const result = JSON.parse(raw);
    for (const quiz of result) {
      expect(typeof quiz.quizId).toBe('string');
      expect(typeof quiz.name).toBe('string');
    }
  });
});
