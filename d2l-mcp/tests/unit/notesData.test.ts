/**
 * G6b: notes.ts — lexical scoring is regex-safe; embedding backfill pages past
 * short rows instead of re-selecting them forever; deleteNoteChunks user scoping.
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

vi.mock('openai', () => {
  class OpenAI {
    embeddings = {
      create: async () => {
        h.embedCount++;
        return { data: [{ embedding: [0.1, 0.2] }] };
      },
    };
  }
  return { OpenAI, default: OpenAI };
});

import { calculateLexicalScore, NotesTools } from '../../src/study/src/notes.js';
import { deleteNoteChunks } from '../../src/rag/vectorStore.js';

beforeEach(() => {
  h.calls.length = 0;
  h.embedCount = 0;
  process.env.OPENAI_API_KEY = 'test-key';
});

describe('calculateLexicalScore — regex metacharacters', () => {
  const section = { title: 'Intro to C++ (a primer)', content: 'c++ is fun. c++ again. a.b and axb. (a' };

  it('does not throw on "c++" and counts literal occurrences', () => {
    expect(() => calculateLexicalScore(section, ['c++'])).not.toThrow();
    // title +10, 2 occurrences * 2 = 4, in first 300 chars +5
    expect(calculateLexicalScore(section, ['c++'])).toBe(19);
  });

  it('does not throw on "(a"', () => {
    expect(() => calculateLexicalScore(section, ['(a'])).not.toThrow();
    // title contains "(a" +10, one occurrence in content +2, first chars +5
    expect(calculateLexicalScore(section, ['(a'])).toBe(17);
  });

  it('treats "." literally ("a.b" does not match "axb")', () => {
    // no title match; 1 literal occurrence +2; first chars +5
    expect(calculateLexicalScore(section, ['a.b'])).toBe(7);
  });

  it('handles pathological ReDoS-style input quickly', () => {
    const long = { title: '', content: 'a'.repeat(5000) };
    const t = Date.now();
    calculateLexicalScore(long, ['(a+)+$']);
    expect(Date.now() - t).toBeLessThan(200);
  });
});

describe('notes_embed_missing — makes progress past short rows', () => {
  it('pages with an id cursor and embeds long rows beyond the first page of short ones', async () => {
    // 150 short rows (ids s000..s149), then 2 long rows. limit=2 → page size 100.
    const all = [
      ...Array.from({ length: 150 }, (_, i) => ({ id: `s${String(i).padStart(3, '0')}`, content: 'short' })),
      { id: 't1', content: 'x'.repeat(300) },
      { id: 't2', content: 'y'.repeat(300) },
    ];
    h.resolver = (c: RecordedCall) => {
      if (c.table !== 'note_sections') return { data: null, error: null };
      if (c.op === 'select' && (c.options as any)?.head) return { count: 150, error: null };
      if (c.op === 'select') {
        const gt = c.filters.find((f) => f[0] === 'gt')?.[2] as string | undefined;
        const lim = c.filters.find((f) => f[0] === 'limit')?.[1] as number;
        const rows = all.filter((r) => (gt === undefined ? true : r.id > gt)).slice(0, lim);
        return { data: rows, error: null };
      }
      return { data: null, error: null };
    };

    const out = JSON.parse(await NotesTools.notes_embed_missing.handler({ limit: 2, userId: 'u1' }));
    expect(out.success).toBe(true);
    expect(out.embedded).toBe(2);
    expect(h.embedCount).toBe(2);

    const selects = h.calls.filter((c: RecordedCall) => c.op === 'select' && !(c.options as any)?.head);
    expect(selects.length).toBe(2);
    expect(selects[0].filters.find((f: any) => f[0] === 'gt')).toBeUndefined();
    expect(selects[1].filters.find((f: any) => f[0] === 'gt')).toEqual(['gt', 'id', 's099']);
    expect(selects[0].filters).toContainEqual(['order', 'id', { ascending: true }]);

    const updates = h.calls.filter((c: RecordedCall) => c.op === 'update');
    expect(updates.map((u: RecordedCall) => u.filters.find((f) => f[0] === 'eq' && f[1] === 'id')?.[2])).toEqual(['t1', 't2']);
    for (const u of updates) expect(u.filters).toContainEqual(['eq', 'user_id', 'u1']);
  });

  it('terminates when every remaining row is too short', async () => {
    h.resolver = (c: RecordedCall) => {
      if (c.op === 'select' && (c.options as any)?.head) return { count: 3, error: null };
      if (c.op === 'select') {
        const gt = c.filters.find((f) => f[0] === 'gt');
        return { data: gt ? [] : [{ id: 'a', content: 'x' }, { id: 'b', content: 'y' }, { id: 'c', content: 'z' }], error: null };
      }
      return { data: null, error: null };
    };
    const out = JSON.parse(await NotesTools.notes_embed_missing.handler({ userId: 'u1' }));
    expect(out.embedded).toBe(0);
    expect(out.skipped).toBe(3);
    expect(h.embedCount).toBe(0);
  });
});

describe('deleteNoteChunks — user scoping', () => {
  it('adds a user_id filter when userId is given', async () => {
    h.resolver = () => ({ error: null });
    await deleteNoteChunks('note-1', 'user-1');
    const del = h.calls.find((c: RecordedCall) => c.op === 'delete' && c.table === 'note_chunks')!;
    expect(del.filters).toContainEqual(['eq', 'note_id', 'note-1']);
    expect(del.filters).toContainEqual(['eq', 'user_id', 'user-1']);
  });

  it('remains backwards-compatible without userId', async () => {
    h.resolver = () => ({ error: null });
    await deleteNoteChunks('note-2');
    const del = h.calls.find((c: RecordedCall) => c.op === 'delete')!;
    expect(del.filters).toEqual([['eq', 'note_id', 'note-2']]);
  });
});
