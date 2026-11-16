import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const sent: any[] = [];
const listPages: any[] = [];
let failList = false;

vi.mock("@aws-sdk/client-s3", () => {
  class Cmd {
    constructor(public input: any) {}
  }
  class ListObjectsV2Command extends Cmd { kind = "list"; }
  class DeleteObjectsCommand extends Cmd { kind = "deleteMany"; }
  class DeleteObjectCommand extends Cmd { kind = "deleteOne"; }
  class GetObjectCommand extends Cmd { kind = "get"; }
  class PutObjectCommand extends Cmd { kind = "put"; }
  class HeadObjectCommand extends Cmd { kind = "head"; }
  class S3Client {
    async send(cmd: any) {
      sent.push(cmd);
      if (cmd.kind === "list") {
        if (failList) throw new Error("AccessDenied");
        return listPages.shift() ?? { Contents: [], IsTruncated: false };
      }
      if (cmd.kind === "deleteMany") return { Deleted: cmd.input.Delete.Objects, Errors: [] };
      return {};
    }
  }
  return {
    S3Client,
    ListObjectsV2Command,
    DeleteObjectsCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand,
    HeadObjectCommand,
  };
});

vi.mock("../../src/utils/auditLog.js", () => ({ logCredentialAccess: vi.fn(async () => {}) }));

const { deleteAllUserData } = await import("../../src/utils/deleteUserData.js");
const { storageStateTempPath, isStorageStateTempFileFor } = await import("../../src/utils/s3Storage.js");

describe("deleteAllUserData", () => {
  const userId = "g2test-" + Math.random().toString(36).slice(2);
  const otherUser = userId + "-user"; // shares a prefix; must NOT be touched
  let mine: string[] = [];
  let theirs: string[] = [];
  const tmp = os.tmpdir();
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

  beforeEach(async () => {
    sent.length = 0;
    process.env.SUPABASE_URL = "https://sb.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    listPages.push(
      {
        Contents: [
          { Key: `browser-state/${userId}/storage-state.json` },
          { Key: `browser-state/${userId}/outline-storage-state.json` },
        ],
        IsTruncated: true,
        NextContinuationToken: "page2",
      },
      { Contents: [{ Key: `browser-state/${userId}/crowdmark-storage-state.json` }], IsTruncated: false }
    );
    failList = false;
    mine = [
      storageStateTempPath(userId),
      storageStateTempPath(userId, "outline"),
      storageStateTempPath(userId, "crowdmark"),
      path.join(tmp, `browser-state-${userId}.json`),
      path.join(tmp, `silent-relogin-state-${userId}.json`),
      path.join(tmp, `cred-login-state-${userId}.json`),
      path.join(tmp, `crowdmark-refresh-${userId}.json`),
    ];
    theirs = [
      storageStateTempPath(otherUser),
      storageStateTempPath(otherUser, "outline"),
      path.join(tmp, `cred-login-state-${otherUser}.json`),
    ];
    for (const f of [...mine, ...theirs]) await fs.writeFile(f, "{}");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    listPages.length = 0;
    for (const f of [...mine, ...theirs]) await fs.rm(f, { force: true });
  });

  it("deletes every browser-state object, OAuth tokens and temp files", async () => {
    const result = await deleteAllUserData(userId);

    // S3: paginated list + batch deletes covering all three service files.
    const lists = sent.filter((c) => c.kind === "list");
    expect(lists).toHaveLength(2);
    expect(lists[0].input.Prefix).toBe(`browser-state/${userId}/`);
    expect(lists[1].input.ContinuationToken).toBe("page2");
    const deletedKeys = sent
      .filter((c) => c.kind === "deleteMany")
      .flatMap((c) => c.input.Delete.Objects.map((o: any) => o.Key));
    expect(deletedKeys.sort()).toEqual(
      [
        `browser-state/${userId}/crowdmark-storage-state.json`,
        `browser-state/${userId}/outline-storage-state.json`,
        `browser-state/${userId}/storage-state.json`,
      ].sort()
    );
    expect(result.deleted.s3State).toBe(true);

    // Supabase REST: credentials, api keys, and all OAuth tables for this user.
    const urls = fetchMock.mock.calls.map((c: any[]) => String(c[0]));
    for (const table of [
      "user_credentials",
      "api_keys",
      "oauth_access_tokens",
      "oauth_refresh_tokens",
      "oauth_authorization_codes",
    ]) {
      expect(urls).toContain(`https://sb.test/rest/v1/${table}?user_id=eq.${userId}`);
    }
    for (const c of fetchMock.mock.calls as any[]) expect(c[1].method).toBe("DELETE");
    expect(result.deleted.oauthTokens).toBe(true);

    // Temp files: this user's removed, the prefix-sharing user's kept.
    for (const f of mine) await expect(fs.access(f)).rejects.toThrow();
    for (const f of theirs) await expect(fs.access(f)).resolves.toBeUndefined();
    expect(result.deleted.tmpFiles).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("deleteAllUserData S3 fallback", () => {
  it("still deletes the known keys when listing fails", async () => {
    sent.length = 0;
    failList = true;
    process.env.SUPABASE_URL = "https://sb.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await deleteAllUserData("g2-fallback-user");
      const singles = sent.filter((c) => c.kind === "deleteOne").map((c) => c.input.Key);
      expect(singles.sort()).toEqual(
        [
          "browser-state/g2-fallback-user/crowdmark-storage-state.json",
          "browser-state/g2-fallback-user/outline-storage-state.json",
          "browser-state/g2-fallback-user/storage-state.json",
        ].sort()
      );
      expect(result.deleted.s3State).toBe(false);
      expect(result.errors.some((e) => e.includes("list/batch"))).toBe(true);
    } finally {
      failList = false;
      vi.unstubAllGlobals();
    }
  });
});

describe("isStorageStateTempFileFor", () => {
  const base = (p: string) => path.basename(p);
  it("matches only the exact user's files", () => {
    expect(isStorageStateTempFileFor(base(storageStateTempPath("dev")), "dev")).toBe(true);
    expect(isStorageStateTempFileFor(base(storageStateTempPath("dev", "outline")), "dev")).toBe(true);
    expect(isStorageStateTempFileFor(base(storageStateTempPath("dev-user")), "dev")).toBe(false);
    expect(isStorageStateTempFileFor(base(storageStateTempPath("dev-user", "crowdmark")), "dev")).toBe(false);
    expect(isStorageStateTempFileFor(base(storageStateTempPath("dev")), "dev-user")).toBe(false);
    expect(isStorageStateTempFileFor("cred-login-state-dev.json", "dev")).toBe(true);
    expect(isStorageStateTempFileFor("cred-login-state-dev-user.json", "dev")).toBe(false);
    expect(isStorageStateTempFileFor("outline-state-dev-1700000000000.json", "dev")).toBe(true);
    expect(isStorageStateTempFileFor("outline-state-dev-user-1700000000000.json", "dev")).toBe(false);
    expect(isStorageStateTempFileFor("browser-state-dev.json", "dev")).toBe(true);
    expect(isStorageStateTempFileFor("browser-state-dev-user.json", "dev")).toBe(false);
    expect(isStorageStateTempFileFor("anything.json", "")).toBe(false);
  });
});
