/**
 * Per-user isolation for the read_file / download_file / delete_file tools.
 * Local files must stay inside {downloadsBase}/{userId}; S3 keys inside users/{userId}/;
 * D2L session cookies only go to the user's own D2L host.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  confinePath,
  resolveFilePath,
  resolveUserS3Key,
  isD2LUrl,
  normalizeHost,
  userDirSegment,
  getUserFilesDir,
} from '../../src/tools/files.js';

let base: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-files-'));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('userDirSegment', () => {
  it('keeps uuid-ish ids and neutralizes path characters', () => {
    expect(userDirSegment('3f2a-uuid_1')).toBe('3f2a-uuid_1');
    expect(userDirSegment('../../etc')).toBe('______etc');
    expect(userDirSegment('')).toBe('anonymous');
  });
});

describe('confinePath', () => {
  it('allows relative and absolute paths inside the base', () => {
    const dir = getUserFilesDir('alice', base);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    expect(confinePath(dir, 'a.txt')).toBe(fs.realpathSync(path.join(dir, 'a.txt')));
    expect(confinePath(dir, path.join(dir, 'a.txt'))).toBe(fs.realpathSync(path.join(dir, 'a.txt')));
    // not-yet-existing file (save target) is fine too
    expect(confinePath(dir, 'new/b.pdf')).toBe(path.join(fs.realpathSync(dir), 'new', 'b.pdf'));
  });

  it('rejects traversal and absolute paths outside the base', () => {
    const dir = getUserFilesDir('alice', base);
    expect(() => confinePath(dir, '../bob/secret.txt')).toThrow(/Access denied/);
    expect(() => confinePath(dir, '/etc/passwd')).toThrow(/Access denied/);
    // sibling dir sharing a prefix ("alice" vs "alice2") must not count as inside
    const sibling = getUserFilesDir('alice2', base);
    expect(() => confinePath(dir, path.join(sibling, 'x'))).toThrow(/Access denied/);
  });

  it('rejects symlinks that escape the base', () => {
    const dir = getUserFilesDir('alice', base);
    const outside = path.join(base, 'outside.txt');
    fs.writeFileSync(outside, 'secret');
    fs.symlinkSync(outside, path.join(dir, 'link.txt'));
    expect(() => confinePath(dir, 'link.txt')).toThrow(/Access denied/);
  });
});

describe('resolveFilePath (per-user)', () => {
  it("finds a user's own file by exact name and by substring", () => {
    const dir = getUserFilesDir('alice', base);
    fs.writeFileSync(path.join(dir, 'Lecture 3 Slides.pdf'), 'x');
    expect(path.basename(resolveFilePath('Lecture 3 Slides.pdf', 'alice', base))).toBe('Lecture 3 Slides.pdf');
    expect(path.basename(resolveFilePath('lecture 3', 'alice', base))).toBe('Lecture 3 Slides.pdf');
  });

  it("never finds another user's file", () => {
    const bobDir = getUserFilesDir('bob', base);
    fs.writeFileSync(path.join(bobDir, 'bob-notes.pdf'), 'x');
    expect(() => resolveFilePath('bob-notes.pdf', 'alice', base)).toThrow(/File not found/);
    expect(() => resolveFilePath(path.join(bobDir, 'bob-notes.pdf'), 'alice', base)).toThrow(/Access denied/);
    expect(() => resolveFilePath('../bob/bob-notes.pdf', 'alice', base)).toThrow(/Access denied/);
  });

  it('rejects arbitrary absolute system paths', () => {
    expect(() => resolveFilePath('/etc/hosts', 'alice', base)).toThrow(/Access denied/);
  });
});

describe('resolveUserS3Key', () => {
  const bucket = 'study-mcp-notes';
  it("accepts keys under the caller's own users/{id}/ prefix", () => {
    expect(resolveUserS3Key('users/u1/notes/x.pdf', 'u1', bucket)).toBe('users/u1/notes/x.pdf');
    expect(resolveUserS3Key(`s3://${bucket}/users/u1/notes/x.pdf`, 'u1', bucket)).toBe('users/u1/notes/x.pdf');
  });

  it("rejects other users' keys, other prefixes and traversal", () => {
    expect(() => resolveUserS3Key('users/u2/notes/x.pdf', 'u1', bucket)).toThrow(/Access denied/);
    expect(() => resolveUserS3Key('s3://browser-state/u2/storage-state.json', 'u1', bucket)).toThrow(/Access denied/);
    expect(() => resolveUserS3Key(`s3://${bucket}/browser-state/u1/storage-state.json`, 'u1', bucket)).toThrow(/Access denied/);
    expect(() => resolveUserS3Key('users/u1/../u2/notes/x.pdf', 'u1', bucket)).toThrow(/Access denied/);
    expect(() => resolveUserS3Key('s3://other-bucket/users/u1/x.pdf', 'u1', bucket)).toThrow(/Access denied/);
  });
});

describe('isD2LUrl / normalizeHost', () => {
  it('matches only the exact D2L host', () => {
    expect(isD2LUrl('https://learn.uwaterloo.ca/content/enforced/1/file.pdf', 'learn.uwaterloo.ca')).toBe(true);
    expect(isD2LUrl('https://LEARN.uwaterloo.ca/x', 'https://learn.uwaterloo.ca/')).toBe(true);
    expect(isD2LUrl('https://evil.example.com/x', 'learn.uwaterloo.ca')).toBe(false);
    expect(isD2LUrl('https://learn.uwaterloo.ca.evil.com/x', 'learn.uwaterloo.ca')).toBe(false);
    expect(isD2LUrl('https://learn.uwaterloo.ca@evil.com/x', 'learn.uwaterloo.ca')).toBe(false);
    expect(isD2LUrl('http://169.254.169.254/latest/meta-data', 'learn.uwaterloo.ca')).toBe(false);
    expect(isD2LUrl('file:///etc/passwd', 'learn.uwaterloo.ca')).toBe(false);
  });

  it('normalizes scheme, path and port', () => {
    expect(normalizeHost('https://learn.uwaterloo.ca:443/d2l')).toBe('learn.uwaterloo.ca');
  });
});
