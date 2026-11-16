/**
 * G6b: piazza.ts — embedding backfill pages past short rows; upsert clears the
 * embedding only for new/changed posts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RecordedCall } from './supabaseMock';

const h = vi.hoisted(() => ({
  resolver: ((_c: any) => ({ data: null, error: null })) as (c: any) => unknown,
  calls: [] as any[],
  embedCount: 0,
}));

vi.mock('../../src/utils/supabase.js', async () => {
  const { createSupabaseMock } = await import('./supabaseMock');
  const m = createSupabaseMock((c) => h.resolver(c));
  h.calls = m.calls;
  return { supabase: m.supabase };
});

vi.mock('../../src/study/piazzaAuth.js', () => ({ getPiazzaCookieHeader: async () => '' }));

vi.mock('openai', () => {
  class OpenAI {
    embeddings = {
      create: async () => {
        h.embedCount++;
        return { data: [{ embedding: [0.3] }] };
      },
    };
  }
  return { OpenAI, default: OpenAI };
});

import { PiazzaTools, upsertPiazzaPosts } from '../../src/study/src/piazza.js';

beforeEach(() => {
  h.calls.length = 0;
  h.embedCount = 0;
  process.env.OPENAI_API_KEY = 'test-key';
});

const row = (post_id: string, title: string, body: string | null) => ({
  user_id: 'u1', course_id: 'CS135', post_id, title, body, url: 'https://piazza.com/x',
  created_at: null, updated_at: null, metadata: {},
});

describe('piazza_embed_missing — cursor paging', () => {
  it('embeds long rows that sit beyond a full page of short rows', async () => {
    const all = [
      ...Array.from({ length: 100 }, (_, i) => ({ id: `a${String(i).padStart(3, '0')}`, title: 'hi', body: '' })),
      { id: 'b1', title: 'long', body: 'z'.repeat(400) },
    ];
    h.resolver = (c: RecordedCall) => {
      if (c.op === 'select' && (c.options as any)?.head) return { count: 100, error: null };
      if (c.op === 'select') {
        const gt = c.filters.find((f) => f[0] === 'gt')?.[2] as string | undefined;
        const lim = c.filters.find((f) => f[0] === 'limit')?.[1] as number;
        return { data: all.filter((r) => gt === undefined || r.id > gt).slice(0, lim), error: null };
      }
      return { data: null, error: null };
    };
    const out = JSON.parse(await PiazzaTools.piazza_embed_missing.handler({ limit: 5, userId: 'u1' }));
    expect(out.embedded).toBe(1);
    expect(out.skipped).toBe(100);
    const upd = h.calls.filter((c: RecordedCall) => c.op === 'update');
    expect(upd).toHaveLength(1);
    expect(upd[0].filters).toContainEqual(['eq', 'id', 'b1']);
    expect(upd[0].filters).toContainEqual(['eq', 'user_id', 'u1']);
  });
});

describe('upsertPiazzaPosts — re-embed on change', () => {
  it('nulls embedding for new and edited posts but not unchanged ones', async () => {
    h.resolver = (c: RecordedCall) => {
      if (c.op === 'select') {
        return {
          data: [
            { course_id: 'CS135', post_id: 'p1', title: 'Same', body: 'same body' },
            { course_id: 'CS135', post_id: 'p2', title: 'Old title', body: 'b' },
          ],
          error: null,
        };
      }
      return { error: null };
    };
    const n = await upsertPiazzaPosts('u1', [
      row('p1', 'Same', 'same body'),
      row('p2', 'New title', 'b'),
      row('p3', 'Brand new', null),
    ]);
    expect(n).toBe(3);
    const ups = h.calls.filter((c: RecordedCall) => c.op === 'upsert');
    const changed = ups.find((u: RecordedCall) => (u.payload as any[]).some((r) => 'embedding' in r))!;
    const unchanged = ups.find((u: RecordedCall) => (u.payload as any[]).every((r) => !('embedding' in r)))!;
    expect((changed.payload as any[]).map((r) => r.post_id).sort()).toEqual(['p2', 'p3']);
    expect((changed.payload as any[]).every((r) => r.embedding === null)).toBe(true);
    expect((unchanged.payload as any[]).map((r) => r.post_id)).toEqual(['p1']);
  });

  it('falls back to nulling all embeddings if existing rows cannot be read', async () => {
    h.resolver = (c: RecordedCall) => (c.op === 'select' ? { data: null, error: { message: 'nope' } } : { error: null });
    await upsertPiazzaPosts('u1', [row('p1', 'A', 'b')]);
    const ups = h.calls.filter((c: RecordedCall) => c.op === 'upsert');
    expect(ups).toHaveLength(1);
    expect((ups[0].payload as any[])[0].embedding).toBeNull();
  });

  it('throws when the upsert fails', async () => {
    h.resolver = (c: RecordedCall) => (c.op === 'select' ? { data: [], error: null } : { error: { message: 'boom' } });
    await expect(upsertPiazzaPosts('u1', [row('p1', 'A', 'b')])).rejects.toThrow(/boom/);
  });
});
