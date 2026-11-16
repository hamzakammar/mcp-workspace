/**
 * G6a: outlineAuth uses the encrypted S3 store, honours the Duo hard stop, and
 * single-flights concurrent cookie refreshes per user.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  launch: vi.fn(),
  loadObj: vi.fn(async () => undefined),
  credRow: { username: 'u', password: 'enc', duo_required_at: null as string | null },
}));

vi.mock('playwright', () => ({ chromium: { launch: h.launch } }));
vi.mock('../../src/utils/s3Storage.js', () => ({
  loadStorageStateObjectFromS3: h.loadObj,
  saveStorageStateToS3: vi.fn(async () => {}),
}));
vi.mock('../../src/utils/kms.js', () => ({ decryptPassword: vi.fn(async () => 'pw') }));
vi.mock('../../src/api/push.js', () => ({ sendPushToUser: vi.fn(async () => 0) }));
vi.mock('../../src/utils/supabase.js', () => {
  const chain: any = {
    select: () => chain, eq: () => chain,
    single: async () => ({ data: h.credRow, error: null }),
    upsert: async () => ({ error: null }),
  };
  return { supabase: { from: () => chain } };
});

import { loginToOutline, getOrRefreshOutlineCookies } from '../../src/study/outlineAuth.js';

beforeEach(() => {
  h.launch.mockReset();
  h.launch.mockRejectedValue(new Error('no browser in tests'));
  h.loadObj.mockClear();
  h.credRow.duo_required_at = null;
});
afterEach(() => vi.unstubAllGlobals());

describe('loginToOutline', () => {
  it('skips the headless browser entirely when duo_required_at is set', async () => {
    h.credRow.duo_required_at = new Date().toISOString();
    expect(await loginToOutline('user-1')).toBeNull();
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.loadObj).not.toHaveBeenCalled();
  });

  it('loads state from the encrypted outline S3 store', async () => {
    expect(await loginToOutline('user-1')).toBeNull(); // launch rejects in tests
    expect(h.loadObj).toHaveBeenCalledWith('user-1', 'outline');
    expect(h.launch).toHaveBeenCalledTimes(1);
  });
});

describe('getOrRefreshOutlineCookies', () => {
  it('shares one refresh across concurrent callers for the same user', async () => {
    let resolveFetch!: (v: any) => void;
    const fetchMock = vi.fn(() => new Promise((r) => { resolveFetch = r; }));
    vi.stubGlobal('fetch', fetchMock);
    const a = getOrRefreshOutlineCookies('user-2');
    const b = getOrRefreshOutlineCookies('user-2');
    expect(a).toBe(b);
    await new Promise((r) => setTimeout(r, 0));
    resolveFetch({ ok: false });
    await expect(a).rejects.toThrow(/Outline authentication failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.launch).toHaveBeenCalledTimes(1);
    // Entry cleared after settle: a later call starts a new refresh.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    await expect(getOrRefreshOutlineCookies('user-2')).rejects.toThrow();
    expect(h.launch).toHaveBeenCalledTimes(2);
  });
});
