/**
 * G6a: per-user headless-login lock shared by auth.ts silent re-login and the
 * scheduled session refresher, plus the headless-login host allowlist gate.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/utils/supabase.js', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../src/utils/s3Storage.js', () => ({
  loadStorageStateObjectFromS3: vi.fn(async () => undefined),
  saveStorageStateToS3: vi.fn(async () => {}),
}));
vi.mock('../../src/utils/auditLog.js', () => ({ logCredentialAccess: vi.fn(async () => {}) }));

import { withHeadlessLoginLock, isHeadlessLoginInFlight, resolveHeadlessLoginHost } from '../../src/auth.js';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('withHeadlessLoginLock', () => {
  it('serializes logins for the same user and reports waited=true to the queued caller', async () => {
    const order: string[] = [];
    const gate = deferred();
    const first = withHeadlessLoginLock('u1', async (waited) => {
      order.push(`first-start:${waited}`);
      await gate.promise;
      order.push('first-end');
      return 1;
    });
    const second = withHeadlessLoginLock('u1', async (waited) => {
      order.push(`second-start:${waited}`);
      return 2;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['first-start:false']);
    expect(isHeadlessLoginInFlight('u1')).toBe(true);
    gate.resolve();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(order).toEqual(['first-start:false', 'first-end', 'second-start:true']);
    expect(isHeadlessLoginInFlight('u1')).toBe(false);
  });

  it('does not block different users', async () => {
    const gate = deferred();
    const a = withHeadlessLoginLock('ua', async () => { await gate.promise; return 'a'; });
    const b = await withHeadlessLoginLock('ub', async (waited) => (waited ? 'waited' : 'b'));
    expect(b).toBe('b');
    gate.resolve();
    expect(await a).toBe('a');
  });

  it('releases the lock when the holder throws', async () => {
    await expect(withHeadlessLoginLock('u2', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(isHeadlessLoginInFlight('u2')).toBe(false);
    expect(await withHeadlessLoginLock('u2', async (waited) => waited)).toBe(false);
  });
});

describe('resolveHeadlessLoginHost', () => {
  it('falls back to the default host when none is stored', () => {
    expect(resolveHeadlessLoginHost(undefined, 'u')).toBe(process.env.D2L_HOST?.toLowerCase() || 'learn.uwaterloo.ca');
  });

  it('normalizes an allowed host', () => {
    expect(resolveHeadlessLoginHost('https://LEARN.uwaterloo.ca/d2l/home', 'u')).toBe('learn.uwaterloo.ca');
  });

  it('refuses a host that is not on the allowlist', () => {
    expect(resolveHeadlessLoginHost('attacker.example.com', 'u')).toBeNull();
    expect(resolveHeadlessLoginHost('10.0.0.1', 'u')).toBeNull();
  });
});

describe('withHeadlessLoginLock timeout', () => {
  it('rejects, aborts the signal, and releases the lock when fn hangs', async () => {
    let seen: AbortSignal | undefined;
    const hung = withHeadlessLoginLock('u-hang', (_w, signal) => { seen = signal; return new Promise(() => {}); }, { timeoutMs: 20 });
    const next = withHeadlessLoginLock('u-hang', async (waited) => `next:${waited}`);
    await expect(hung).rejects.toThrow('HEADLESS_LOGIN_TIMEOUT');
    expect(seen?.aborted).toBe(true);
    expect(await next).toBe('next:true');
    expect(isHeadlessLoginInFlight('u-hang')).toBe(false);
  });

  it('closeBrowserOnAbort closes the browser when the signal aborts', async () => {
    const { closeBrowserOnAbort } = await import('../../src/auth.js');
    const close = vi.fn(async () => {});
    const c = new AbortController();
    closeBrowserOnAbort(c.signal, { close });
    expect(close).not.toHaveBeenCalled();
    c.abort();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('silent re-login after waiting on another login', () => {
  it('reuses a token only if it changed while waiting and Duo is not flagged', async () => {
    const { forceRefreshToken } = await import('../../src/auth.js');
    let stored = 'TOKEN_A';
    let duo: string | null = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.includes('select=duo_required_at')
        ? [{ duo_required_at: duo }]
        : [{ host: 'learn.uwaterloo.ca', token: stored, updated_at: new Date().toISOString() }],
    })));
    try {
      const gate = deferred();
      const holder = withHeadlessLoginLock('u-reuse', async () => { await gate.promise; stored = 'TOKEN_B'; });
      const relogin = forceRefreshToken('u-reuse');
      await new Promise((r) => setTimeout(r, 10));
      gate.resolve();
      await holder;
      expect(await relogin).toBe('TOKEN_B');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
