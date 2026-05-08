/**
 * Unit tests for pingD2LSession — the lightweight "is the session still alive?"
 * probe that runs before every headless browser refresh cycle.
 *
 * The interesting cases are cookie rotation: D2L occasionally sends new cookie
 * values in Set-Cookie response headers. pingD2LSession must capture these and
 * return an updated token so the old cookies don't expire mid-session.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// sessionRefresher imports supabase and auth at module load; stub them before importing
vi.mock('../../src/utils/supabase.js', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }), upsert: async () => ({ error: null }) }),
  },
}));
vi.mock('../../src/auth.js', () => ({ getD2LCredentials: async () => null }));

import { pingD2LSession } from '../../src/jobs/sessionRefresher.js';

const VALID_TOKEN = JSON.stringify({
  d2lSessionVal: 'sess_abc123',
  d2lSecureSessionVal: 'secure_xyz789',
});

// ─── Mock fetch helper ────────────────────────────────────────────────────────

function mockPingResponse(status: number, setCookie?: string) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'set-cookie' ? (setCookie ?? null) : null,
    },
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Basic liveness ───────────────────────────────────────────────────────────

describe('pingD2LSession — session liveness', () => {
  it('returns original token when session is alive (200, no Set-Cookie)', async () => {
    mockPingResponse(200);
    const result = await pingD2LSession('user-1', 'learn.uwaterloo.ca', VALID_TOKEN);
    expect(result).toBe(VALID_TOKEN);
  });

  it('returns null on 401 (session expired)', async () => {
    mockPingResponse(401);
    const result = await pingD2LSession('user-1', 'learn.uwaterloo.ca', VALID_TOKEN);
    expect(result).toBeNull();
  });

  it('returns null on 302 (session redirected to login)', async () => {
    mockPingResponse(302);
    const result = await pingD2LSession('user-1', 'learn.uwaterloo.ca', VALID_TOKEN);
    expect(result).toBeNull();
  });

  it('returns null on 403', async () => {
    mockPingResponse(403);
    const result = await pingD2LSession('user-1', 'learn.uwaterloo.ca', VALID_TOKEN);
    expect(result).toBeNull();
  });

  it('returns null when token is not valid JSON', async () => {
    const result = await pingD2LSession('user-1', 'learn.uwaterloo.ca', 'not-json');
    expect(result).toBeNull();
  });

  it('returns null when token is JSON but missing required cookie fields', async () => {
    const badToken = JSON.stringify({ someOtherField: 'value' });
    const result = await pingD2LSession('user-1', 'learn.uwaterloo.ca', badToken);
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await pingD2LSession('user-1', 'learn.uwaterloo.ca', VALID_TOKEN);
    expect(result).toBeNull();
  });
});

// ─── Cookie rotation ──────────────────────────────────────────────────────────

describe('pingD2LSession — cookie rotation', () => {
  it('returns updated token when d2lSessionVal is rotated in Set-Cookie', async () => {
    mockPingResponse(200, 'd2lSessionVal=newSessVal; Path=/; HttpOnly');
    const result = await pingD2LSession('user-1', 'learn.uwaterloo.ca', VALID_TOKEN);

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.d2lSessionVal).toBe('newSessVal');
    // secure value should be carried over from original token
    expect(parsed.d2lSecureSessionVal).toBe('secure_xyz789');
  });

  it('returns updated token when d2lSecureSessionVal is rotated', async () => {
    mockPingResponse(200, 'd2lSecureSessionVal=newSecureVal; Path=/; Secure; HttpOnly');
    const result = await pingD2LSession('user-1', 'learn.uwaterloo.ca', VALID_TOKEN);

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.d2lSessionVal).toBe('sess_abc123'); // original preserved
    expect(parsed.d2lSecureSessionVal).toBe('newSecureVal');
  });

  it('handles multiple Set-Cookie headers joined with ", " separator', async () => {
    // Node's fetch joins multiple Set-Cookie headers with ", "
    const setCookie =
      'd2lSessionVal=rotatedSess; Path=/, d2lSecureSessionVal=rotatedSecure; Path=/; Secure';
    mockPingResponse(200, setCookie);
    const result = await pingD2LSession('user-1', 'learn.uwaterloo.ca', VALID_TOKEN);

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.d2lSessionVal).toBe('rotatedSess');
    expect(parsed.d2lSecureSessionVal).toBe('rotatedSecure');
  });

  it('returns original token when Set-Cookie has unrelated cookies (no d2l cookies)', async () => {
    mockPingResponse(200, 'csrfToken=abc; Path=/');
    const result = await pingD2LSession('user-1', 'learn.uwaterloo.ca', VALID_TOKEN);
    expect(result).toBe(VALID_TOKEN);
  });

  it('updated token is valid JSON with both cookie fields', async () => {
    mockPingResponse(200, 'd2lSessionVal=brand-new; Path=/');
    const result = await pingD2LSession('user-1', 'learn.uwaterloo.ca', VALID_TOKEN);
    expect(() => JSON.parse(result!)).not.toThrow();
    const parsed = JSON.parse(result!);
    expect(parsed).toHaveProperty('d2lSessionVal');
    expect(parsed).toHaveProperty('d2lSecureSessionVal');
  });
});
