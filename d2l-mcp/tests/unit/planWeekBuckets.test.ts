/**
 * plan_week bucketing: overdue items (fetched via the 14-day lookback) must land in
 * `overdue` rather than being dropped.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/utils/supabase.js', () => ({ supabase: {} }));
vi.mock('../../src/study/src/notes.js', () => ({ NotesTools: {} }));

import { bucketPlanTasks, OVERDUE_LOOKBACK_DAYS } from '../../src/study/src/planning.js';

describe('bucketPlanTasks', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  const t = (id: string, due: string) => ({ id, title: id, due_at: due, course_id: 'CS241' });

  it('buckets overdue / due within 72h / later in window', () => {
    const { overdue, due_soon, this_week } = bucketPlanTasks(
      [
        t('past', '2026-10-05T03:59:00Z'),
        t('soon', '2026-10-10T03:59:00Z'),
        t('later', '2026-10-14T03:59:00Z'),
        t('beyond', '2026-10-30T03:59:00Z'),
      ],
      now,
      7,
    );
    expect(overdue.map((x) => x.id)).toEqual(['past']);
    expect(due_soon.map((x) => x.id)).toEqual(['soon']);
    expect(this_week.map((x) => x.id)).toEqual(['later']);
  });

  it('looks back far enough to populate overdue', () => {
    expect(OVERDUE_LOOKBACK_DAYS).toBeGreaterThan(0);
  });
});
