/**
 * G6b: sync_all propagates D2L title / due-date changes to existing tasks
 * (filtered by user_id + source + source_ref) and never touches status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RecordedCall } from './supabaseMock';

const h = vi.hoisted(() => ({
  resolver: ((_c: any) => ({ data: null, error: null })) as (c: any) => unknown,
  calls: [] as any[],
  folders: [] as any[],
}));

vi.mock('../../src/utils/supabase.js', async () => {
  const { createSupabaseMock } = await import('./supabaseMock');
  const m = createSupabaseMock((c) => h.resolver(c));
  h.calls = m.calls;
  return { supabase: m.supabase };
});

vi.mock('../../src/client.js', () => ({
  D2LClient: class {
    async getMyEnrollments() {
      return {
        Items: [{
          OrgUnit: { Id: 42, Name: 'CS 135', Type: { Code: 'Course Offering', Name: 'Course Offering' } },
          Access: { IsActive: true, CanAccess: true },
        }],
      };
    }
    async getDropboxFolders() {
      return h.folders;
    }
  },
}));

import { SyncTools } from '../../src/study/src/sync.js';

const folder = (Id: number, Name: string, DueDate: string) => ({
  Id, Name, DueDate, Attachments: [], LinkAttachments: [], CustomInstructions: null, Assessment: { ScoreDenominator: 10 },
});

beforeEach(() => {
  h.calls.length = 0;
});

function existingTasks(map: Record<string, { id: string; title: string; due_at: string }>) {
  h.resolver = (c: RecordedCall) => {
    if (c.table === 'tasks' && c.op === 'select') {
      const ref = c.filters.find((f) => f[0] === 'eq' && f[1] === 'source_ref')?.[2] as string;
      return { data: map[ref] ?? null, error: null };
    }
    return { data: [{}], error: null };
  };
}

describe('sync_all — update existing tasks', () => {
  it('updates title and due_at when D2L changed them, scoped by user/source/source_ref, without status', async () => {
    h.folders = [folder(1, 'A1 (renamed)', '2026-12-01T04:59:00.000Z')];
    existingTasks({ '42-1': { id: 't1', title: 'A1', due_at: '2026-11-20T04:59:00+00:00' } });

    const out = JSON.parse(await SyncTools.sync_all.handler({ userId: 'u1' }));
    expect(out.success).toBe(true);
    expect(out.totalUpdated).toBe(1);
    expect(out.totalAdded).toBe(0);

    const upd = h.calls.filter((c: RecordedCall) => c.op === 'update');
    expect(upd).toHaveLength(1);
    expect(upd[0].payload).toEqual({ title: 'A1 (renamed)', due_at: '2026-12-01T04:59:00.000Z' });
    expect(upd[0].payload).not.toHaveProperty('status');
    expect(upd[0].filters).toContainEqual(['eq', 'user_id', 'u1']);
    expect(upd[0].filters.some((f: any) => f[1] === 'source')).toBe(false);
    expect(upd[0].filters).toContainEqual(['select', 'id']);
    expect(upd[0].filters).toContainEqual(['eq', 'source_ref', '42-1']);
  });

  it('does not count an update that matched zero rows', async () => {
    h.folders = [folder(1, 'A1 (renamed)', '2026-12-01T04:59:00.000Z')];
    h.resolver = (c: RecordedCall) => {
      if (c.table === 'tasks' && c.op === 'select') return { data: { id: 't1', title: 'A1', due_at: '2026-11-20T04:59:00Z' }, error: null };
      if (c.op === 'update') return { data: [], error: null };
      return { data: [{}], error: null };
    };
    const out = JSON.parse(await SyncTools.sync_all.handler({ userId: 'u1' }));
    expect(out.totalUpdated).toBe(0);
  });

  it('does not update when nothing changed (same instant in a different ISO format)', async () => {
    h.folders = [folder(1, 'A1', '2026-11-20T04:59:00.000Z')];
    existingTasks({ '42-1': { id: 't1', title: 'A1', due_at: '2026-11-20T04:59:00+00:00' } });
    const out = JSON.parse(await SyncTools.sync_all.handler({ userId: 'u1' }));
    expect(out.totalUpdated).toBe(0);
    expect(h.calls.filter((c: RecordedCall) => c.op === 'update' || c.op === 'insert')).toHaveLength(0);
  });

  it('still inserts new tasks with an ISO due_at and status open', async () => {
    h.folders = [folder(2, 'A2', '2026-12-05T04:59:00.000Z')];
    existingTasks({});
    const out = JSON.parse(await SyncTools.sync_all.handler({ userId: 'u1' }));
    expect(out.totalAdded).toBe(1);
    const ins = h.calls.find((c: RecordedCall) => c.op === 'insert')!;
    expect(ins.payload).toMatchObject({ user_id: 'u1', source_ref: '42-2', due_at: '2026-12-05T04:59:00.000Z', status: 'open' });
  });
});
