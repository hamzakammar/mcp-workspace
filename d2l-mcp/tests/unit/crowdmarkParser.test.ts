/**
 * Unit tests for Crowdmark JSON:API response parsing.
 *
 * Crowdmark's internal API uses JSON:API format where assignment titles live
 * in the `included` array (type "exam-masters"), not on the primary data objects.
 * This was the exact bug that caused UUIDs to appear as assignment titles.
 *
 * All tests mock global fetch — no Crowdmark account required.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// crowdmarkClient imports supabase at module load; stub it before importing
vi.mock('../../src/utils/supabase.js', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }), upsert: async () => ({ error: null }) }),
  },
}));

import {
  fetchCrowdmarkAssignments,
  fetchCrowdmarkResult,
  CrowdmarkAuthError,
} from '../../src/study/crowdmarkClient.js';

// ─── Mock fetch helper ────────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── fetchCrowdmarkAssignments ────────────────────────────────────────────────

describe('fetchCrowdmarkAssignments', () => {
  it('resolves title from exam-master in included array', async () => {
    mockFetch(200, {
      data: [{
        id: 'assignment-uuid-1',
        type: 'assignments',
        relationships: {
          'exam-master': { data: { type: 'exam-masters', id: 'master-1' } },
        },
      }],
      included: [{
        id: 'master-1',
        type: 'exam-masters',
        attributes: { title: 'M119 W26 A10', type: 'assignment' },
      }],
    });

    const result = await fetchCrowdmarkAssignments('session=abc');
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('M119 W26 A10');
    expect(result[0].type).toBe('assignment');
    expect(result[0].id).toBe('assignment-uuid-1');
  });

  it('falls back to assignment UUID when exam-master is absent from included', async () => {
    mockFetch(200, {
      data: [{
        id: 'assignment-uuid-orphan',
        type: 'assignments',
        relationships: {
          'exam-master': { data: { type: 'exam-masters', id: 'master-missing' } },
        },
      }],
      included: [], // exam-master not here
    });

    const result = await fetchCrowdmarkAssignments('session=abc');
    expect(result[0].title).toBe('assignment-uuid-orphan');
  });

  it('falls back to assignment ID when there is no exam-master relationship', async () => {
    mockFetch(200, {
      data: [{
        id: 'assignment-no-rel',
        type: 'assignments',
        relationships: {},
      }],
      included: [],
    });

    const result = await fetchCrowdmarkAssignments('session=abc');
    expect(result[0].title).toBe('assignment-no-rel');
  });

  it('falls back to exam-master ID when title attribute is missing', async () => {
    mockFetch(200, {
      data: [{
        id: 'a1',
        type: 'assignments',
        relationships: { 'exam-master': { data: { id: 'master-notitle' } } },
      }],
      included: [{
        id: 'master-notitle',
        type: 'exam-masters',
        attributes: {}, // no title
      }],
    });

    const result = await fetchCrowdmarkAssignments('session=abc');
    expect(result[0].title).toBe('master-notitle');
  });

  it('handles multiple assignments with different exam-masters', async () => {
    mockFetch(200, {
      data: [
        { id: 'a1', type: 'assignments', relationships: { 'exam-master': { data: { id: 'm1' } } } },
        { id: 'a2', type: 'assignments', relationships: { 'exam-master': { data: { id: 'm2' } } } },
      ],
      included: [
        { id: 'm1', type: 'exam-masters', attributes: { title: 'Midterm', type: 'exam' } },
        { id: 'm2', type: 'exam-masters', attributes: { title: 'Assignment 1', type: 'assignment' } },
      ],
    });

    const result = await fetchCrowdmarkAssignments('session=abc');
    expect(result).toHaveLength(2);
    expect(result.find(r => r.id === 'a1')?.title).toBe('Midterm');
    expect(result.find(r => r.id === 'a2')?.title).toBe('Assignment 1');
  });

  it('returns empty array when data is empty', async () => {
    mockFetch(200, { data: [], included: [] });
    const result = await fetchCrowdmarkAssignments('session=abc');
    expect(result).toEqual([]);
  });

  it('ignores non-exam-master entries in included (no cross-type pollution)', async () => {
    mockFetch(200, {
      data: [{ id: 'a1', type: 'assignments', relationships: { 'exam-master': { data: { id: 'm1' } } } }],
      included: [
        { id: 'm1', type: 'courses', attributes: { title: 'Should Be Ignored' } }, // wrong type
        { id: 'm1', type: 'exam-masters', attributes: { title: 'Correct Title' } },
      ],
    });

    const result = await fetchCrowdmarkAssignments('session=abc');
    expect(result[0].title).toBe('Correct Title');
  });

  it('throws CrowdmarkAuthError on 401', async () => {
    mockFetch(401, {});
    await expect(fetchCrowdmarkAssignments('session=expired')).rejects.toThrow(CrowdmarkAuthError);
  });

  it('throws CrowdmarkAuthError on 403', async () => {
    mockFetch(403, {});
    await expect(fetchCrowdmarkAssignments('session=forbidden')).rejects.toThrow(CrowdmarkAuthError);
  });
});

// ─── fetchCrowdmarkResult ─────────────────────────────────────────────────────

describe('fetchCrowdmarkResult', () => {
  it('calculates percentage: 15 out of 20 = 75.0', async () => {
    mockFetch(200, {
      data: {
        id: 'result-1',
        attributes: { total_points: 20, class_results: { mean: 13.5 } },
        relationships: {
          'exam-questions': { data: [{ id: 'q1' }, { id: 'q2' }] },
        },
      },
      included: [
        { id: 'q1', type: 'exam-questions', attributes: { label: 'Q1', points: 10, earned_points: 8 } },
        { id: 'q2', type: 'exam-questions', attributes: { label: 'Q2', points: 10, earned_points: 7 } },
      ],
    });

    const result = await fetchCrowdmarkResult('session=abc', 'result-1');
    expect(result.totalPoints).toBe(20);
    expect(result.earnedPoints).toBe(15);
    expect(result.percentage).toBe(75.0);
  });

  it('rounds percentage to 1 decimal place', async () => {
    // 1/3 ≈ 33.333... → should round to 33.3
    mockFetch(200, {
      data: {
        id: 'r1',
        attributes: { total_points: 3, class_results: null },
        relationships: { 'exam-questions': { data: [{ id: 'q1' }] } },
      },
      included: [
        { id: 'q1', type: 'exam-questions', attributes: { label: 'Q1', points: 3, earned_points: 1 } },
      ],
    });

    const result = await fetchCrowdmarkResult('session=abc', 'r1');
    expect(result.percentage).toBe(33.3);
  });

  it('rounds classAverage to 1 decimal place', async () => {
    mockFetch(200, {
      data: {
        id: 'r1',
        attributes: { total_points: 10, class_results: { mean: 7.666 } },
        relationships: { 'exam-questions': { data: [{ id: 'q1' }] } },
      },
      included: [
        { id: 'q1', type: 'exam-questions', attributes: { label: 'Q1', points: 10, earned_points: 8 } },
      ],
    });

    const result = await fetchCrowdmarkResult('session=abc', 'r1');
    expect(result.classAverage).toBe(7.7);
  });

  it('sums earned_points across all questions', async () => {
    mockFetch(200, {
      data: {
        id: 'r1',
        attributes: { total_points: 30, class_results: null },
        relationships: { 'exam-questions': { data: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }] } },
      },
      included: [
        { id: 'q1', type: 'exam-questions', attributes: { label: '1', points: 10, earned_points: 9 } },
        { id: 'q2', type: 'exam-questions', attributes: { label: '2', points: 10, earned_points: 7 } },
        { id: 'q3', type: 'exam-questions', attributes: { label: '3', points: 10, earned_points: 5 } },
      ],
    });

    const result = await fetchCrowdmarkResult('session=abc', 'r1');
    expect(result.earnedPoints).toBe(21);
  });

  it('maps question labels and feedback annotations', async () => {
    mockFetch(200, {
      data: {
        id: 'r1',
        attributes: { total_points: 10, class_results: null },
        relationships: { 'exam-questions': { data: [{ id: 'q1' }] } },
      },
      included: [{
        id: 'q1',
        type: 'exam-questions',
        attributes: {
          label: 'Part (a)',
          points: 10,
          earned_points: 8,
          annotations: [
            { comment: 'Good work' },
            { comment: 'Minor sign error' },
            { comment: '' }, // empty — should be filtered
          ],
        },
      }],
    });

    const result = await fetchCrowdmarkResult('session=abc', 'r1');
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].label).toBe('Part (a)');
    expect(result.questions[0].feedback).toEqual(['Good work', 'Minor sign error']);
    // empty comment filtered out
    expect(result.questions[0].feedback).not.toContain('');
  });

  it('returns null earnedPoints when there are no exam-questions', async () => {
    mockFetch(200, {
      data: {
        id: 'r1',
        attributes: { total_points: 20, class_results: null },
        relationships: { 'exam-questions': { data: [] } },
      },
      included: [],
    });

    const result = await fetchCrowdmarkResult('session=abc', 'r1');
    expect(result.earnedPoints).toBeNull();
    expect(result.percentage).toBeNull();
  });

  it('returns null classAverage when class_results is null', async () => {
    mockFetch(200, {
      data: {
        id: 'r1',
        attributes: { total_points: 10, class_results: null },
        relationships: { 'exam-questions': { data: [] } },
      },
      included: [],
    });

    const result = await fetchCrowdmarkResult('session=abc', 'r1');
    expect(result.classAverage).toBeNull();
  });

  it('throws CrowdmarkAuthError on 401', async () => {
    mockFetch(401, {});
    await expect(fetchCrowdmarkResult('session=expired', 'r1')).rejects.toThrow(CrowdmarkAuthError);
  });
});
