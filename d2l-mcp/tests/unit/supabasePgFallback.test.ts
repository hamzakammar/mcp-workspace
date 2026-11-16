import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryMock = vi.fn();
const poolCtorArgs: any[] = [];

vi.mock('pg', () => {
  class Pool {
    constructor(opts: any) {
      poolCtorArgs.push(opts);
    }
    query = (...args: any[]) => queryMock(...args);
  }
  return { default: { Pool } };
});

async function loadClient() {
  vi.resetModules();
  const mod = await import('../../src/utils/supabase.js');
  return mod.supabase as any;
}

describe('supabase pg fallback', () => {
  beforeEach(() => {
    queryMock.mockReset();
    poolCtorArgs.length = 0;
    vi.stubEnv('SUPABASE_URL', 'postgresql://user:pw@localhost:5432/db');
    vi.stubEnv('PG_CA_CERT', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves { data: null, error } instead of hanging when the query rejects', async () => {
    const boom = new Error('connection refused');
    queryMock.mockRejectedValue(boom);
    const sb = await loadClient();

    const results = await Promise.all([
      sb.from('t').select('*').eq('a', 1),
      sb.from('t').select('*').order('a').limit(5),
      sb.from('t').insert({ a: 1 }),
      sb.from('t').insert({ a: 1 }).select('id'),
      sb.from('t').insert({ a: 1 }).select('id').single(),
      sb.from('t').upsert({ a: 1 }, { onConflict: 'a' }),
      sb.from('t').update({ a: 2 }).eq('id', 1),
      sb.from('t').update({ a: 2 }).eq('id', 1).select('id'),
      sb.from('t').delete().eq('id', 1),
    ]);
    for (const r of results) {
      expect(r).toEqual({ data: null, error: boom });
    }
  });

  it('still resolves rows on success and supports .then(onFulfilled, onRejected)', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: 1 }] });
    const sb = await loadClient();
    const onRejected = vi.fn();
    const r = await sb.from('t').insert({ a: 1 }).then((v: any) => v, onRejected);
    expect(r).toEqual({ data: [{ id: 1 }], error: null });
    expect(onRejected).not.toHaveBeenCalled();
  });

  it('keeps unverified SSL by default and verifies when PG_CA_CERT is set', async () => {
    await loadClient();
    expect(poolCtorArgs[0].ssl).toEqual({ rejectUnauthorized: false });

    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const caPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g4-ca-')), 'ca.pem');
    fs.writeFileSync(caPath, 'FAKE-CA');
    vi.stubEnv('PG_CA_CERT', caPath);
    await loadClient();
    expect(poolCtorArgs[1].ssl).toEqual({ rejectUnauthorized: true, ca: 'FAKE-CA' });
  });
});
