/**
 * Task 5 — what_should_i_work_on integration test
 */

import { describe, it, expect } from 'vitest';

const RUN = process.env.D2L_INTEGRATION_TESTS === 'true';
const ECE124 = 1221444;

describe.skipIf(!RUN)('what_should_i_work_on (Task 5)', () => {
  it('returns recommendations array and summary for ECE 124', async () => {
    const { priorityTools } = await import('../src/tools/priority.js');
    const raw = await priorityTools.what_should_i_work_on.handler({
      orgUnitId: ECE124,
      hoursAhead: 168, // 7 days to catch something
    });
    const result = JSON.parse(raw);
    expect(Array.isArray(result.recommendations)).toBe(true);
    expect(typeof result.summary).toBe('string');
    for (const rec of result.recommendations) {
      expect(typeof rec.reason).toBe('string');
      expect(rec.reason.length).toBeGreaterThan(0);
    }
  });
});
