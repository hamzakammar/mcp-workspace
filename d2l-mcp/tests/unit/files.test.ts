import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { resolveFilePath, getUserFilesDir, chooseSavePath, streamToFileCapped, MAX_DOWNLOAD_BYTES } from '../../src/tools/files.js';

let base: string;
beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'g5-files-')); });
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe('resolveFilePath strict mode (delete_file)', () => {
  it('allows exact and case-insensitive exact names but not substrings', () => {
    const dir = getUserFilesDir('alice', base);
    fs.writeFileSync(path.join(dir, 'Lecture 3 Slides.pdf'), 'x');
    const strict = { allowSubstringMatch: false };
    expect(path.basename(resolveFilePath('Lecture 3 Slides.pdf', 'alice', base, strict))).toBe('Lecture 3 Slides.pdf');
    expect(path.basename(resolveFilePath('lecture 3 slides.PDF', 'alice', base, strict))).toBe('Lecture 3 Slides.pdf');
    expect(() => resolveFilePath('lecture 3', 'alice', base, strict)).toThrow(/File not found/);
    // reads keep the substring fallback
    expect(path.basename(resolveFilePath('lecture 3', 'alice', base))).toBe('Lecture 3 Slides.pdf');
  });
});

describe('chooseSavePath', () => {
  it('uses a new file path in a new folder verbatim', () => {
    const dir = getUserFilesDir('alice', base);
    const target = path.join(dir, 'newdir', 'notes.pdf');
    expect(chooseSavePath('server-name.pdf', dir, target)).toBe(target);
  });

  it('treats a new extensionless path as a folder', () => {
    const dir = getUserFilesDir('alice', base);
    expect(chooseSavePath('a.pdf', dir, path.join(dir, 'week1'))).toBe(path.join(dir, 'week1', 'a.pdf'));
  });

  it('existing directory → dir/filename; no savePath → downloads dir', () => {
    const dir = getUserFilesDir('alice', base);
    expect(chooseSavePath('a.pdf', dir, dir)).toBe(path.join(dir, 'a.pdf'));
    expect(chooseSavePath('a.pdf', dir)).toBe(path.join(dir, 'a.pdf'));
  });
});

describe('streamToFileCapped', () => {
  it('writes small streams', async () => {
    const f = path.join(base, 'ok.bin');
    const n = await streamToFileCapped(Readable.from([Buffer.from('hello')]), f);
    expect(n).toBe(5);
    expect(fs.readFileSync(f, 'utf8')).toBe('hello');
  });

  it('aborts past the cap and removes the partial file', async () => {
    const f = path.join(base, 'big.bin');
    const chunk = Buffer.alloc(1024 * 1024);
    const chunks = Math.ceil(MAX_DOWNLOAD_BYTES / chunk.length) + 1;
    function* gen() { for (let i = 0; i < chunks; i++) yield chunk; }
    await expect(streamToFileCapped(Readable.from(gen()), f)).rejects.toThrow(/too large/);
    expect(fs.existsSync(f)).toBe(false);
  });
});
