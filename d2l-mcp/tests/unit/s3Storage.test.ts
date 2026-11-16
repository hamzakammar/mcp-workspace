/**
 * G6a: decrypted storage state must not land in a shared, never-deleted temp
 * file. loadStorageStateObjectFromS3 returns it in memory; the legacy
 * path-returning API writes a unique 0600 file per call.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { send = sendMock; },
  GetObjectCommand: class { constructor(public input: any) {} },
  PutObjectCommand: class { constructor(public input: any) {} },
  DeleteObjectCommand: class { constructor(public input: any) {} },
  HeadObjectCommand: class { constructor(public input: any) {} },
}));
vi.mock('../../src/utils/kms.js', () => ({
  encryptEnvelope: vi.fn(),
  decryptEnvelope: vi.fn(async (buf: Buffer) => ({ plaintext: buf.toString('utf-8').slice(4), captured_at: new Date().toISOString() })),
  isEncryptedEnvelope: (buf: Buffer) => buf.subarray(0, 4).toString() === 'ENC:',
  readEnvelopeCapturedAt: () => new Date().toISOString(),
  KMS_KEY_ARN: undefined,
}));
vi.mock('../../src/utils/auditLog.js', () => ({ logCredentialAccess: vi.fn(async () => {}) }));

import {
  loadStorageStateFromS3,
  loadStorageStateObjectFromS3,
  storageStateTempPath,
} from '../../src/utils/s3Storage.js';

const STATE = { cookies: [{ name: 'c', value: 'v', domain: 'x', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' }], origins: [] };

function s3Returns(body: string, metadata: Record<string, string> = {}) {
  sendMock.mockResolvedValue({
    Body: { transformToByteArray: async () => new Uint8Array(Buffer.from(body)) },
    Metadata: metadata,
  });
}

afterEach(() => sendMock.mockReset());

describe('loadStorageStateObjectFromS3', () => {
  it('returns the parsed encrypted state without writing a file', async () => {
    s3Returns('ENC:' + JSON.stringify(STATE));
    const writeSpy = vi.spyOn(fs, 'writeFile');
    const state = await loadStorageStateObjectFromS3('user-1', 'crowdmark');
    expect(state).toEqual(STATE);
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('returns the parsed legacy state', async () => {
    s3Returns(JSON.stringify(STATE));
    expect(await loadStorageStateObjectFromS3('user-1')).toEqual(STATE);
  });

  it('honours rejectIfLegacy', async () => {
    s3Returns(JSON.stringify(STATE));
    expect(await loadStorageStateObjectFromS3('user-1', undefined, { rejectIfLegacy: true })).toBeUndefined();
  });

  it('returns undefined for non-JSON plaintext', async () => {
    s3Returns('ENC:not json');
    expect(await loadStorageStateObjectFromS3('user-1')).toBeUndefined();
  });

  it('returns undefined when the object is missing', async () => {
    sendMock.mockRejectedValue(Object.assign(new Error('nope'), { name: 'NoSuchKey' }));
    expect(await loadStorageStateObjectFromS3('user-1')).toBeUndefined();
  });
});

describe('loadStorageStateFromS3 (path API, backward compatible)', () => {
  it('writes a unique 0600 temp file per call', async () => {
    s3Returns('ENC:' + JSON.stringify(STATE));
    const p1 = await loadStorageStateFromS3('user-1', 'outline');
    const p2 = await loadStorageStateFromS3('user-1', 'outline');
    try {
      expect(p1).toBeTruthy();
      expect(p1).not.toBe(p2);
      expect(path.basename(p1!)).toMatch(/^browser-state-outline-user-1-[0-9a-f]{16}\.json$/);
      expect(JSON.parse(await fs.readFile(p1!, 'utf-8'))).toEqual(STATE);
      if (process.platform !== 'win32') {
        expect((await fs.stat(p1!)).mode & 0o777).toBe(0o600);
      }
    } finally {
      for (const p of [p1, p2]) if (p) await fs.unlink(p).catch(() => {});
    }
  });
});

describe('storageStateTempPath', () => {
  it('defaults the service to d2l and strips path characters from ids', () => {
    expect(path.basename(storageStateTempPath('../evil'))).toMatch(/^browser-state-d2l-evil-[0-9a-f]{16}\.json$/);
  });
});

describe('saveStorageStateToS3 with a state object', () => {
  it('uploads the JSON without reading or writing a file', async () => {
    const { saveStorageStateToS3 } = await import('../../src/utils/s3Storage.js');
    sendMock.mockResolvedValue({});
    const readSpy = vi.spyOn(fs, 'readFile');
    await saveStorageStateToS3('user-1', STATE as any, undefined, 'crowdmark');
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
    const cmd = sendMock.mock.calls[0][0];
    expect(cmd.input.Key).toBe('browser-state/user-1/crowdmark-storage-state.json');
    expect(JSON.parse(cmd.input.Body)).toEqual(STATE);
  });
});
