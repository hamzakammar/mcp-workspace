import { describe, it, expect, vi } from 'vitest';
import {
  BoundedTtlCache,
  SerializedFileWriter,
  claimOrCheckSession,
  dedupeInFlight,
  generateSessionId,
  resolveSessionOwnership,
  resolveSessionSecret,
  verifySessionId,
  parseContentRangeTotal,
  parsePersistedSessions,
  pickEvictions,
  pruneSessions,
  serializeSessions,
  sessionBelongsTo,
  sortByDueAt,
  truncateForToolResult,
} from '../../src/utils/mcpSessions.js';

describe('session persistence', () => {
  it('migrates legacy array entries as unclaimed and keeps them across a save/load', () => {
    const { sessions, migratedLegacy } = parsePersistedSessions(['a', 'b'], 50);
    expect(migratedLegacy).toBe(2);
    expect(sessions.get('a')).toEqual({ userId: null, lastSeen: 50 });
    const again = parsePersistedSessions(JSON.parse(serializeSessions(sessions)), 999);
    expect(again.sessions.get('b')).toEqual({ userId: null, lastSeen: 50 });
  });

  it('binds an unclaimed legacy id to its first user (TOFU), then enforces ownership', () => {
    const { sessions } = parsePersistedSessions(['legacy-1']);
    expect(sessionBelongsTo(sessions, 'legacy-1', 'u1')).toBe(false);
    expect(claimOrCheckSession(sessions, 'legacy-1', 'u1')).toEqual({ ok: true, claimed: true });
    expect(claimOrCheckSession(sessions, 'legacy-1', 'u1')).toEqual({ ok: true, claimed: false });
    expect(claimOrCheckSession(sessions, 'legacy-1', 'u2')).toEqual({ ok: false, claimed: false });
    expect(claimOrCheckSession(sessions, 'missing', 'u1')).toEqual({ ok: false, claimed: false });
    // Claim survives persistence.
    const again = parsePersistedSessions(JSON.parse(serializeSessions(sessions)));
    expect(again.sessions.get('legacy-1')?.userId).toBe('u1');
  });

  it('prunes unclaimed legacy ids after the TTL', () => {
    const { sessions } = parsePersistedSessions(['old'], 0);
    expect(pruneSessions(sessions, 8 * 86400000, 7 * 86400000, () => false)).toBe(1);
    expect(sessions.size).toBe(0);
  });

  it('round-trips the v2 format and skips malformed entries', () => {
    const { sessions } = parsePersistedSessions(
      { version: 2, sessions: { s1: { userId: 'u1', lastSeen: 5 }, s2: { lastSeen: 1 }, s3: 'x', s4: { userId: 'u2' } } },
      100
    );
    expect([...sessions.keys()].sort()).toEqual(['s1', 's4']);
    expect(sessions.get('s4')).toEqual({ userId: 'u2', lastSeen: 100 });
    const again = parsePersistedSessions(JSON.parse(serializeSessions(sessions)));
    expect(again.sessions).toEqual(sessions);
  });

  it('only lets the owning user use a session id', () => {
    const m = new Map([['s1', { userId: 'u1', lastSeen: 0 }]]);
    expect(sessionBelongsTo(m, 's1', 'u1')).toBe(true);
    expect(sessionBelongsTo(m, 's1', 'u2')).toBe(false);
    expect(sessionBelongsTo(m, 'nope', 'u1')).toBe(false);
  });

  it('prunes stale sessions but keeps live ones', () => {
    const m = new Map([
      ['old', { userId: 'u', lastSeen: 0 }],
      ['oldLive', { userId: 'u', lastSeen: 0 }],
      ['fresh', { userId: 'u', lastSeen: 990 }],
    ]);
    expect(pruneSessions(m, 1000, 100, (sid) => sid === 'oldLive')).toBe(1);
    expect([...m.keys()].sort()).toEqual(['fresh', 'oldLive']);
  });
});

describe('signed session ids', () => {
  const secret = 'test-secret';
  const uuid = '123e4567-e89b-42d3-a456-426614174000';

  it('generates `${uuid}.${22-char base64url sig}` and verifies only for the issuing user', () => {
    const sid = generateSessionId('u1', secret, uuid);
    expect(sid).toMatch(/^123e4567-e89b-42d3-a456-426614174000\.[A-Za-z0-9_-]{22}$/);
    expect(verifySessionId(sid, 'u1', secret)).toBe('valid');
    expect(verifySessionId(sid, 'u2', secret)).toBe('mismatch');
    expect(verifySessionId(sid, 'u1', 'other-secret')).toBe('mismatch');
    // Tampered signature
    const tampered = sid.slice(0, -1) + (sid.endsWith('A') ? 'B' : 'A');
    expect(verifySessionId(tampered, 'u1', secret)).toBe('mismatch');
  });

  it('falls back to a plain uuid without a secret; plain ids are "unsigned"', () => {
    expect(generateSessionId('u1', null, uuid)).toBe(uuid);
    expect(verifySessionId(uuid, 'u1', secret)).toBe('unsigned');
    expect(verifySessionId(generateSessionId('u1', secret, uuid), 'u1', null)).toBe('unsigned');
  });

  it('resolves the secret with the documented fallback chain', () => {
    expect(resolveSessionSecret({ MCP_SESSION_SECRET: 'a', OAUTH_SESSION_SECRET: 'b', STUDY_MCP_TOKEN: 'c' } as any)).toBe('a');
    expect(resolveSessionSecret({ OAUTH_SESSION_SECRET: 'b', STUDY_MCP_TOKEN: 'c' } as any)).toBe('b');
    expect(resolveSessionSecret({ STUDY_MCP_TOKEN: 'c' } as any)).toBe('c');
    expect(resolveSessionSecret({} as any)).toBeNull();
  });

  it('restores a signed id for its user with an empty session file (stateless) and records it', () => {
    const sessions = new Map();
    const sid = generateSessionId('u1', secret, uuid);
    expect(resolveSessionOwnership(sessions, sid, 'u1', secret, 7)).toEqual({ ok: true, changed: true });
    expect(sessions.get(sid)).toEqual({ userId: 'u1', lastSeen: 7 });
    expect(resolveSessionOwnership(sessions, sid, 'u1', secret)).toEqual({ ok: true, changed: false });
  });

  it('rejects a signed id for another user even if the file says otherwise', () => {
    const sid = generateSessionId('u1', secret, uuid);
    const sessions = new Map([[sid, { userId: 'u2', lastSeen: 0 }]]);
    expect(resolveSessionOwnership(sessions, sid, 'u2', secret)).toEqual({ ok: false, changed: false });
  });

  it('uses file/TOFU logic for unsigned ids', () => {
    const { sessions } = parsePersistedSessions(['legacy']);
    expect(resolveSessionOwnership(sessions, 'legacy', 'u1', secret)).toEqual({ ok: true, changed: true });
    expect(resolveSessionOwnership(sessions, 'legacy', 'u2', secret)).toEqual({ ok: false, changed: false });
    expect(resolveSessionOwnership(sessions, 'unknown', 'u1', secret)).toEqual({ ok: false, changed: false });
  });
});

describe('pickEvictions', () => {
  const seen: Record<string, number> = { a: 3, b: 1, c: 2 };
  it('returns nothing under the cap', () => {
    expect(pickEvictions(['a', 'b'], (s) => seen[s], 3)).toEqual([]);
  });
  it('evicts the oldest so one more fits', () => {
    expect(pickEvictions(['a', 'b', 'c'], (s) => seen[s], 3)).toEqual(['b']);
    expect(pickEvictions(['a', 'b', 'c'], (s) => seen[s], 2)).toEqual(['b', 'c']);
  });
  it('skips busy transports', () => {
    expect(pickEvictions(['a', 'b', 'c'], (s) => seen[s], 3, (s) => s === 'b')).toEqual(['c']);
    expect(pickEvictions(['a', 'b'], (s) => seen[s], 2, () => true)).toEqual([]);
  });
});

describe('SerializedFileWriter', () => {
  it('writes one at a time via temp+rename and coalesces to the latest content', async () => {
    let active = 0;
    let maxActive = 0;
    const files: Record<string, string> = {};
    const fsMock = {
      writeFile: vi.fn(async (p: string, c: string) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        files[p] = c;
        active--;
      }),
      rename: vi.fn(async (from: string, to: string) => {
        files[to] = files[from];
        delete files[from];
      }),
    };
    const w = new SerializedFileWriter('/x/sessions.json', fsMock as any);
    await Promise.all([w.write('1'), w.write('2'), w.write('3')]);
    expect(maxActive).toBe(1);
    expect(files['/x/sessions.json']).toBe('3');
    // First write + one coalesced write of the latest content.
    expect(fsMock.writeFile).toHaveBeenCalledTimes(2);
    expect(fsMock.rename).toHaveBeenCalledTimes(2);
    expect(Object.keys(files)).toEqual(['/x/sessions.json']);
  });

  it('resolves even when the write fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = new SerializedFileWriter('/x/s.json', {
      writeFile: vi.fn().mockRejectedValue(new Error('EACCES')),
      rename: vi.fn(),
    } as any);
    await expect(w.write('a')).resolves.toBeUndefined();
    errSpy.mockRestore();
  });
});

describe('dedupeInFlight', () => {
  it('shares one promise for concurrent callers and clears afterwards', async () => {
    const inFlight = new Map<string, Promise<number>>();
    const factory = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 42;
    });
    const [a, b] = await Promise.all([
      dedupeInFlight(inFlight, 'k', factory),
      dedupeInFlight(inFlight, 'k', factory),
    ]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(inFlight.size).toBe(0);
  });

  it('clears the entry on failure so a later call retries', async () => {
    const inFlight = new Map<string, Promise<number>>();
    await expect(dedupeInFlight(inFlight, 'k', async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(inFlight.size).toBe(0);
    await expect(dedupeInFlight(inFlight, 'k', async () => 1)).resolves.toBe(1);
  });
});

describe('BoundedTtlCache', () => {
  it('expires entries after the TTL', () => {
    let t = 0;
    const c = new BoundedTtlCache<number>(100, 10, () => t);
    c.set('a', 1);
    t = 99;
    expect(c.get('a')).toBe(1);
    t = 100;
    expect(c.get('a')).toBeUndefined();
  });

  it('evicts the oldest entry when full', () => {
    let t = 0;
    const c = new BoundedTtlCache<number>(1000, 2, () => t);
    c.set('a', 1);
    t = 1;
    c.set('b', 2);
    t = 2;
    c.set('c', 3);
    expect(c.size).toBe(2);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
  });
});

describe('sortByDueAt', () => {
  it('sorts by actual timestamp, not by "5h"/"2d" strings', () => {
    const items = [
      { title: '2d', dueAt: '2026-11-18T12:00:00Z' },
      { title: '5h', dueAt: '2026-11-16T17:00:00Z' },
      { title: 'bad', dueAt: 'not a date' },
      { title: '20h', dueAt: '2026-11-17T08:00:00Z' },
    ];
    expect(sortByDueAt(items).map((i) => i.title)).toEqual(['5h', '20h', '2d', 'bad']);
  });
});

describe('truncateForToolResult', () => {
  it('leaves short text alone', () => {
    expect(truncateForToolResult('abc', 10)).toBe('abc');
  });
  it('truncates long text with a note', () => {
    const out = truncateForToolResult('x'.repeat(25), 10);
    expect(out).toBe(`${'x'.repeat(10)}\n\n[truncated: 10 of 25 characters shown]`);
  });
});

describe('parseContentRangeTotal', () => {
  it('parses PostgREST Content-Range totals', () => {
    expect(parseContentRangeTotal('0-0/123')).toBe(123);
    expect(parseContentRangeTotal('*/0')).toBe(0);
    expect(parseContentRangeTotal('0-0/*')).toBeNull();
    expect(parseContentRangeTotal(null)).toBeNull();
  });
});
