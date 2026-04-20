/**
 * Task 3 — get_announcements integration test
 */

import { describe, it, expect } from 'vitest';

const RUN = process.env.D2L_INTEGRATION_TESTS === 'true';
const ECE124 = 1221444;

describe.skipIf(!RUN)('get_announcements (Task 3)', () => {
  it('returns an array for ECE 124', async () => {
    const { newsTools } = await import('../src/tools/news.js');
    const raw = await newsTools.get_announcements.handler({ orgUnitId: ECE124 });
    const result = JSON.parse(raw);
    expect(Array.isArray(result)).toBe(true);
  });

  it('filters by since date', async () => {
    const { newsTools } = await import('../src/tools/news.js');
    // Far-future date should yield empty array
    const raw = await newsTools.get_announcements.handler({
      orgUnitId: ECE124,
      since: '2099-01-01T00:00:00Z',
    });
    const result = JSON.parse(raw);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });
});
