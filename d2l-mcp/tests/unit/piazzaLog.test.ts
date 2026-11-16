import { describe, it, expect } from 'vitest';
import { summarizePiazzaLoginBody } from '../../src/study/piazzaAuth.js';

describe('summarizePiazzaLoginBody', () => {
  it('surfaces only result/error status fields', () => {
    const out = summarizePiazzaLoginBody(JSON.stringify({ result: 'OK', error: null, aid: 'secret-aid', session_id: 'sess-123' }));
    expect(out).toBe('result=OK error=null');
    expect(out).not.toContain('sess-123');
    expect(out).not.toContain('secret-aid');
  });

  it('describes non-JSON bodies by size only', () => {
    expect(summarizePiazzaLoginBody('<html>session_id=abc</html>')).toBe('non-JSON body (27 bytes)');
  });

  it('surfaces login error messages', () => {
    expect(summarizePiazzaLoginBody(JSON.stringify({ result: null, error: 'Email or password incorrect' })))
      .toBe('result=object error=Email or password incorrect');
  });
});
