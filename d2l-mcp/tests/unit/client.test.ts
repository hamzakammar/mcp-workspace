import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/auth.js', () => ({
  getToken: vi.fn(async () => 'tok'),
  forceRefreshToken: vi.fn(async () => null),
  getD2LToken: vi.fn(async () => null),
}));

import { D2LClient, D2LApiError, clearD2LClientCaches, clearD2LHostCache, D2L_REQUEST_TIMEOUT_MS } from '../../src/client.js';
import { getD2LToken } from '../../src/auth.js';
import { DEFAULT_D2L_HOST } from '../../src/utils/d2lHost.js';

const tokenMock = vi.mocked(getD2LToken);
let fetchMock: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  clearD2LClientCaches();
  tokenMock.mockReset();
  tokenMock.mockResolvedValue(null);
  process.env.D2L_ALLOWED_HOSTS = 'learn.other.edu';
  fetchMock = vi.fn(async () => json({}));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  delete process.env.D2L_ALLOWED_HOSTS;
  vi.unstubAllGlobals();
});

const urlOf = (i = 0) => String(fetchMock.mock.calls[i][0]);

describe('host resolution', () => {
  it('falls back to DEFAULT_D2L_HOST (not learn.ul.ie) with no stored host', async () => {
    await new D2LClient('u1').whoami();
    expect(new URL(urlOf()).hostname).toBe(DEFAULT_D2L_HOST);
    expect(urlOf()).not.toContain('learn.ul.ie');
  });

  it("uses the user's stored host when it is allowed", async () => {
    tokenMock.mockResolvedValue({ host: 'https://Learn.Other.edu/', token: 't' });
    await new D2LClient('u1').whoami();
    expect(new URL(urlOf()).hostname).toBe('learn.other.edu');
  });

  it('refuses a stored host that is not allowed', async () => {
    tokenMock.mockResolvedValue({ host: 'evil.example.com', token: 't' });
    await expect(new D2LClient('u1').whoami()).rejects.toThrow(/not an allowed D2L host/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a constructor host that is not allowed', async () => {
    await expect(new D2LClient('u1', '169.254.169.254').whoami()).rejects.toThrow(/not an allowed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts an allowed constructor host without a DB lookup', async () => {
    await new D2LClient('u1', 'learn.other.edu').whoami();
    expect(new URL(urlOf()).hostname).toBe('learn.other.edu');
    expect(tokenMock).not.toHaveBeenCalled();
  });
});

describe('host cache', () => {
  it('caches the DEFAULT_D2L_HOST fallback too, and clearD2LHostCache forgets it', async () => {
    await new D2LClient('u9').whoami();
    await new D2LClient('u9').whoami();
    expect(tokenMock).toHaveBeenCalledTimes(1);
    clearD2LHostCache('u9');
    await new D2LClient('u9').whoami();
    expect(tokenMock).toHaveBeenCalledTimes(2);
  });
});

describe('request', () => {
  it('passes an abort signal (timeout) to fetch', async () => {
    await new D2LClient('u1').whoami();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(D2L_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it('reports a timeout clearly', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('t'), { name: 'TimeoutError' }));
    await expect(new D2LClient('u1').whoami()).rejects.toThrow(/timed out/);
  });

  it('throws D2LApiError with status on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    const err = await new D2LClient('u1').whoami().catch((e) => e);
    expect(err).toBeInstanceOf(D2LApiError);
    expect(err.status).toBe(404);
    expect(err.message).toBe('D2L API error 404: nope');
  });
});

describe('paging', () => {
  it('getMyEnrollments follows PagingInfo bookmarks', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Items: [{ id: 1 }], PagingInfo: { Bookmark: '1', HasMoreItems: true } }))
      .mockResolvedValueOnce(json({ Items: [{ id: 2 }], PagingInfo: { Bookmark: '2', HasMoreItems: false } }));
    const res = (await new D2LClient('u1').getMyEnrollments()) as { Items: unknown[] };
    expect(res.Items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(urlOf(1)).toContain('myenrollments/?bookmark=1');
  });

  it('getMyEnrollments stops at the page cap', async () => {
    let n = 0;
    fetchMock.mockImplementation(async () => json({ Items: [n], PagingInfo: { Bookmark: String(++n), HasMoreItems: true } }));
    const res = (await new D2LClient('u1').getMyEnrollments()) as { Items: unknown[] };
    expect(res.Items).toHaveLength(20);
  });

  it('getQuizzes follows ObjectListPage Next on the same host only', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Objects: [{ QuizId: 1 }], Next: `https://${DEFAULT_D2L_HOST}/d2l/api/le/1.67/9/quizzes/?bookmark=b` }))
      .mockResolvedValueOnce(json({ Objects: [{ QuizId: 2 }], Next: 'https://evil.example.com/next' }));
    const res = (await new D2LClient('u1').getQuizzes(9)) as { Objects: unknown[] };
    expect(res.Objects).toEqual([{ QuizId: 1 }, { QuizId: 2 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(1)).toContain('/quizzes/?bookmark=b');
  });
});

describe('documented routes', () => {
  it('getQuizAttempts uses /attempts/?userId=<whoami>', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Identifier: '777' }))
      .mockResolvedValueOnce(json({ Objects: [], Next: null }));
    await new D2LClient('u1').getQuizAttempts(9, 5);
    expect(urlOf(1)).toMatch(/\/d2l\/api\/le\/1\.67\/9\/quizzes\/5\/attempts\/\?userId=777$/);
    expect(urlOf(1)).not.toContain('myAttempts');
  });

  it('getRubrics passes objectType/objectId', async () => {
    fetchMock.mockResolvedValueOnce(json([]));
    await new D2LClient('u1').getRubrics(9, 'Dropbox', 42);
    expect(urlOf()).toMatch(/\/rubrics\/\?objectType=Dropbox&objectId=42$/);
  });
});
