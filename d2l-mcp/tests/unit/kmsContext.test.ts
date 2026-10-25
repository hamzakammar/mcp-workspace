/**
 * Unit tests for per-user KMS Encryption Context binding on stored passwords.
 *
 * The AWS KMS client is mocked with a faithful model of Encryption Context semantics:
 * a ciphertext encrypted WITH a context can only be decrypted by supplying the exact
 * same context; a context mismatch (or supplying none) throws InvalidCiphertextException,
 * exactly as real KMS does. This proves:
 *   - a D2L password is bound to its owning user (cross-user ciphertext is rejected),
 *   - legacy rows (encrypted with no context) still decrypt via the unbound fallback.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// kms.ts reads KMS_KEY_ARN into a const at import time — set it before imports evaluate.
vi.hoisted(() => { process.env.KMS_KEY_ARN = "arn:aws:kms:us-east-1:000000000000:key/test"; });

// Self-contained KMS fake. Ciphertext blob = JSON({ pt, ctx }); decrypt requires a
// deep-equal EncryptionContext (absent ⇔ {}), else it throws like real KMS. Captured
// commands are exposed on globalThis so a test can assert what was sent.
vi.mock("@aws-sdk/client-kms", () => {
  const sameCtx = (a: Record<string, string> = {}, b: Record<string, string> = {}) => {
    const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
    return ak.length === bk.length && ak.every((k, i) => k === bk[i] && a[k] === b[k]);
  };
  class EncryptCommand { static __kind = "Encrypt"; input: any; constructor(i: any) { this.input = i; } }
  class DecryptCommand { static __kind = "Decrypt"; input: any; constructor(i: any) { this.input = i; } }
  class GenerateDataKeyCommand { static __kind = "GenerateDataKey"; input: any; constructor(i: any) { this.input = i; } }
  const calls: any[] = [];
  (globalThis as any).__kmsCalls = calls;
  class KMSClient {
    async send(cmd: any) {
      calls.push(cmd);
      const kind = (cmd?.constructor as any)?.__kind;
      if (kind === "Encrypt") {
        const blob = Buffer.from(JSON.stringify({
          pt: Buffer.from(cmd.input.Plaintext).toString("utf-8"),
          ctx: cmd.input.EncryptionContext ?? {},
        }));
        return { CiphertextBlob: new Uint8Array(blob) };
      }
      if (kind === "Decrypt") {
        const parsed = JSON.parse(Buffer.from(cmd.input.CiphertextBlob).toString("utf-8"));
        if (!sameCtx(parsed.ctx ?? {}, cmd.input.EncryptionContext ?? {})) {
          const e = new Error("InvalidCiphertextException"); e.name = "InvalidCiphertextException"; throw e;
        }
        return { Plaintext: new Uint8Array(Buffer.from(parsed.pt, "utf-8")) };
      }
      throw new Error("unexpected KMS command");
    }
  }
  return { KMSClient, EncryptCommand, DecryptCommand, GenerateDataKeyCommand };
});

import { encryptPassword, decryptPassword, d2lPasswordContext } from "../../src/utils/kms.js";

const kmsCalls = (): any[] => (globalThis as any).__kmsCalls;
beforeEach(() => { kmsCalls().length = 0; });

describe("d2lPasswordContext", () => {
  it("binds to userId + a fixed purpose", () => {
    expect(d2lPasswordContext("user-A")).toEqual({ userId: "user-A", purpose: "d2l_password" });
  });
});

describe("KMS password encryption with Encryption Context", () => {
  it("round-trips with the matching user context", async () => {
    const ctx = d2lPasswordContext("user-A");
    const ct = await encryptPassword("hunter2", ctx);
    expect(ct.startsWith("enc:kms:v1:")).toBe(true);
    expect(await decryptPassword(ct, ctx)).toBe("hunter2");
  });

  it("passes the EncryptionContext through to KMS on encrypt", async () => {
    await encryptPassword("pw", d2lPasswordContext("user-A"));
    const enc = kmsCalls().find((c) => (c.constructor as any).__kind === "Encrypt");
    expect(enc.input.EncryptionContext).toEqual({ userId: "user-A", purpose: "d2l_password" });
  });

  it("REJECTS another user's ciphertext (cross-user protection)", async () => {
    const ct = await encryptPassword("hunter2", d2lPasswordContext("user-A"));
    await expect(decryptPassword(ct, d2lPasswordContext("user-B"))).rejects.toThrow();
  });

  it("decrypts a legacy (no-context) ciphertext via the unbound fallback", async () => {
    const legacy = await encryptPassword("legacyPw"); // no context, like pre-hardening rows
    expect(await decryptPassword(legacy, d2lPasswordContext("user-A"))).toBe("legacyPw");
  });

  it("passes through plaintext that was never encrypted", async () => {
    expect(await decryptPassword("plain-not-enc", d2lPasswordContext("user-A"))).toBe("plain-not-enc");
  });
});
