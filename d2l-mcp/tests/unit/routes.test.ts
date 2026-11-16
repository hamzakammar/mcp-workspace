/**
 * G3: HTTP API route hardening — host allowlist, safe D2L file fetch,
 * credential rollback, Notion state, input validation.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { makeFakeSupabase, type SbCall } from "./fakeSupabase.js";

let respond: (call: SbCall) => { data?: unknown; error?: unknown } = () => ({});
const sb = makeFakeSupabase((c) => respond(c));
const enrollments = vi.fn();

vi.mock("../../src/utils/supabase.js", () => ({ supabase: sb }));
vi.mock("../../src/client.js", () => ({
  D2LClient: class {
    constructor(public userId: string, public host: string) {}
    getMyEnrollments() { return enrollments(this.host); }
  },
}));
vi.mock("../../src/auth.js", () => ({
  getToken: vi.fn(async () => "cookie=1"),
  clearTokenCache: vi.fn(),
}));
vi.mock("../../src/utils/kms.js", () => ({
  encryptPassword: vi.fn(async (p: string) => `enc:${p}`),
  d2lPasswordContext: (u: string) => ({ u }),
}));
vi.mock("../../src/utils/auditLog.js", () => ({ logCredentialAccess: vi.fn(async () => {}) }));

const routes = await import("../../src/api/routes.js");
const { verifyNotionState } = await import("../../src/api/oauth/crypto.js");

let server: Server;
let base: string;

beforeAll(async () => {
  process.env.OAUTH_SESSION_SECRET = "test-secret";
  process.env.NOTION_CLIENT_ID = "cid";
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).userId = "user-1"; next(); });
  app.use("/api", routes.default);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => server?.close());
beforeEach(() => {
  sb.calls.length = 0;
  respond = () => ({});
  enrollments.mockReset();
});

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("D2L host allowlist on write paths", () => {
  for (const [path, body] of [
    ["/d2l/connect-and-sync", { host: "evil.example.com", cookies: "x" }],
    ["/d2l/connect-cookie", { host: "169.254.169.254", cookies: "x" }],
    ["/d2l/token", { host: "localhost", token: "x" }],
    ["/d2l/connect", { host: "attacker.com", username: "u", password: "p" }],
    ["/d2l/save-credentials", { host: "internal.corp", username: "u", password: "p" }],
  ] as const) {
    it(`${path} rejects an unlisted host without touching the DB`, async () => {
      const r = await post(path, body);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "Unsupported D2L host" });
      expect(sb.calls.filter((c) => c.op !== "select")).toHaveLength(0);
    });
  }

  it("stores the normalized host", async () => {
    enrollments.mockResolvedValue({ Items: [] });
    const r = await post("/d2l/connect-cookie", { host: "https://Learn.UWaterloo.ca/d2l/home", cookies: "c" });
    expect(r.status).toBe(200);
    const up = sb.calls.find((c) => c.op === "upsert")!;
    expect((up.payload as any).host).toBe("learn.uwaterloo.ca");
  });
});

describe("failed verification rolls back instead of deleting", () => {
  const prev = { host: "learn.uwaterloo.ca", username: "olduser", password: "enc:old", token: "oldtok", updated_at: "2026-01-01" };

  it("connect-cookie restores previous token/host and keeps username/password", async () => {
    respond = (c) => (c.op === "select" ? { data: [prev] } : {});
    enrollments.mockRejectedValue(new Error("401"));
    const r = await post("/d2l/connect-cookie", { host: "learn.uwaterloo.ca", cookies: "bad" });
    expect(r.status).toBe(400);
    expect(sb.calls.some((c) => c.op === "delete")).toBe(false);
    const upd = sb.calls.find((c) => c.op === "update")!;
    expect(upd.payload).toEqual({ host: prev.host, token: prev.token, updated_at: prev.updated_at });
    // Only rolls back if the row still holds the cookies this request wrote
    expect(upd.filters).toContainEqual(["eq", "token", "bad"]);
  });

  it("token route restores previous token", async () => {
    respond = (c) => (c.op === "select" ? { data: [prev] } : {});
    enrollments.mockRejectedValue(new Error("401"));
    const r = await post("/d2l/token", { host: "learn.uwaterloo.ca", token: "bad" });
    expect(r.status).toBe(400);
    expect(sb.calls.some((c) => c.op === "delete")).toBe(false);
    expect(sb.calls.find((c) => c.op === "update")!.payload).toMatchObject({ token: "oldtok" });
  });

  it("connect restores previous username/password, never deletes the row", async () => {
    respond = (c) => (c.op === "select" ? { data: [prev] } : {});
    enrollments.mockRejectedValue(new Error("Invalid credentials"));
    const r = await post("/d2l/connect", { host: "learn.uwaterloo.ca", username: "new", password: "wrong" });
    expect(r.status).toBe(401);
    expect(sb.calls.some((c) => c.op === "delete")).toBe(false);
    const upd = sb.calls.find((c) => c.op === "update")!;
    expect(upd.payload).toEqual({
      host: prev.host, username: "olduser", password: "enc:old", updated_at: prev.updated_at,
    });
    expect(upd.filters).toContainEqual(["eq", "password", "enc:wrong"]);
  });

  it("with no previous row, removes only the row this request created", async () => {
    respond = (c) => (c.op === "select" ? { data: [] } : {});
    enrollments.mockRejectedValue(new Error("401"));
    const r = await post("/d2l/connect-cookie", { host: "learn.uwaterloo.ca", cookies: "bad" });
    expect(r.status).toBe(400);
    const del = sb.calls.find((c) => c.op === "delete")!;
    expect(del.filters).toContainEqual(["eq", "token", "bad"]);
  });
});

describe("Notion oauth-url", () => {
  it("emits a signed state that verifyNotionState accepts", async () => {
    const r = await fetch(base + "/notion/oauth-url");
    const { url } = await r.json();
    const state = new URL(url).searchParams.get("state")!;
    expect(verifyNotionState(state)).toBe("user-1");
  });
});

describe("input validation", () => {
  it("notes/process rejects a non-string s3Key with 400", async () => {
    const r = await post("/notes/process", { s3Key: ["users/user-1/x"], title: "t" });
    expect(r.status).toBe(400);
  });

  it("presign-upload rejects oversized and junk contentType", async () => {
    expect((await post("/notes/presign-upload", { filename: "a.pdf", contentType: "application/pdf", size: 10 ** 10 })).status).toBe(400);
    expect((await post("/notes/presign-upload", { filename: "a.pdf", contentType: "text/html\r\nX: y", size: 10 })).status).toBe(400);
    expect((await post("/notes/presign-upload", { filename: "a.pdf", contentType: "application/pdf", size: -1 })).status).toBe(400);
  });
});

describe("DELETE /api-keys/:id", () => {
  const del = (id: string) => fetch(`${base}/api-keys/${id}`, { method: "DELETE" });

  it("404 when nothing matched for this user", async () => {
    respond = () => ({ data: [] });
    expect((await del("k1")).status).toBe(404);
    const call = sb.calls[0];
    expect(call.filters).toContainEqual(["eq", "user_id", "user-1"]);
  });
  it("500 on db error", async () => {
    respond = () => ({ error: { message: "boom" } });
    expect((await del("k1")).status).toBe(500);
  });
  it("200 when revoked", async () => {
    respond = () => ({ data: [{ id: "k1" }] });
    expect((await del("k1")).status).toBe(200);
  });
});

describe("fetchD2LFileSafely", () => {
  const host = "learn.uwaterloo.ca";
  const redirect = (loc: string, status = 302) => new Response(null, { status, headers: { location: loc } });
  const publicLookup = async () => [{ address: "93.184.216.34" }];

  it("follows same-host redirects manually and keeps the cookie", async () => {
    const seen: Array<{ url: string; init: any }> = [];
    const f = vi.fn(async (url: any, init: any) => {
      seen.push({ url: String(url), init });
      return seen.length === 1 ? redirect("/content/file.pdf") : new Response("ok");
    });
    const { resp } = await routes.fetchD2LFileSafely(`https://${host}/d2l/x`, host, "c=1", { fetchImpl: f as any });
    expect(await resp.text()).toBe("ok");
    expect(seen.map((s) => s.url)).toEqual([`https://${host}/d2l/x`, `https://${host}/content/file.pdf`]);
    expect(seen.every((s) => s.init.redirect === "manual" && s.init.headers.Cookie === "c=1")).toBe(true);
  });

  it("follows an https off-host (CDN) redirect without the cookie when it resolves public", async () => {
    const seen: Array<{ url: string; init: any }> = [];
    const f = vi.fn(async (url: any, init: any) => {
      seen.push({ url: String(url), init });
      return seen.length === 1 ? redirect("https://cdn.example.net/signed?sig=1") : new Response("pdf");
    });
    const { resp } = await routes.fetchD2LFileSafely(`https://${host}/a`, host, "c=1", { fetchImpl: f as any, lookup: publicLookup });
    expect(await resp.text()).toBe("pdf");
    expect(seen[1].url).toBe("https://cdn.example.net/signed?sig=1");
    expect(seen[1].init.headers.Cookie).toBeUndefined();
  });

  it("treats a different port on the D2L hostname as off-host (no cookie)", async () => {
    const seen: any[] = [];
    const f = vi.fn(async (_u: any, init: any) => { seen.push(init); return seen.length === 1 ? redirect(`https://${host}:8443/x`) : new Response("x"); });
    await routes.fetchD2LFileSafely(`https://${host}/a`, host, "c=1", { fetchImpl: f as any, lookup: publicLookup });
    expect(seen[1].headers.Cookie).toBeUndefined();
  });

  it("refuses http, private-IP and internal-resolving redirects", async () => {
    const internalLookup = async () => [{ address: "10.0.0.5" }];
    for (const loc of ["http://learn.uwaterloo.ca/x", "https://169.254.169.254/", "https://[::1]/", "https://internal.example.com/x"]) {
      const f = vi.fn(async () => redirect(loc));
      await expect(
        routes.fetchD2LFileSafely(`https://${host}/a`, host, "c", { fetchImpl: f as any, lookup: internalLookup }),
      ).rejects.toMatchObject({ status: 502 });
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses a start URL that is not on the D2L host", async () => {
    const f = vi.fn();
    await expect(routes.fetchD2LFileSafely("https://evil.example.com/", host, "c", { fetchImpl: f as any })).rejects.toMatchObject({ status: 400 });
    expect(f).not.toHaveBeenCalled();
  });

  it("gives up after 5 redirects", async () => {
    const f = vi.fn(async () => redirect(`https://${host}/loop`));
    await expect(routes.fetchD2LFileSafely(`https://${host}/a`, host, "c", { fetchImpl: f as any })).rejects.toMatchObject({ status: 502 });
    expect(f).toHaveBeenCalledTimes(6);
  });

  it("times out waiting for headers with 504", async () => {
    const f = vi.fn((_u: any, init: any) => new Promise<Response>((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason))));
    await expect(
      routes.fetchD2LFileSafely(`https://${host}/a`, host, "c", { fetchImpl: f as any, headerTimeoutMs: 20 }),
    ).rejects.toMatchObject({ status: 504 });
  });
});

describe("file proxy response headers", () => {
  const realFetch = globalThis.fetch;
  afterAll(() => { globalThis.fetch = realFetch; });

  async function proxy(contentType: string) {
    respond = (c) => (c.table === "user_credentials" ? { data: [{ host: "learn.uwaterloo.ca", token: "t" }] } : {});
    globalThis.fetch = (async (url: any, init?: any) =>
      String(url).startsWith("http://127.0.0.1")
        ? realFetch(url, init)
        : new Response("body", { headers: { "content-type": contentType } })) as any;
    try {
      return await realFetch(`${base}/d2l/courses/1/file?url=${encodeURIComponent("/content/x")}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  it("serves PDFs inline with nosniff", async () => {
    const r = await proxy("application/pdf");
    expect(r.status).toBe(200);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(await r.text()).toBe("body");
  });

  it("forces non-PDF content to download", async () => {
    const r = await proxy("text/html");
    expect(r.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("size and type checks", () => {
  it("exceedsMaxSize uses content-length", () => {
    expect(routes.exceedsMaxSize(new Response("x", { headers: { "content-length": String(60 * 1024 * 1024) } }))).toBe(true);
    expect(routes.exceedsMaxSize(new Response("x"))).toBe(false);
  });
  it("readBodyWithLimit aborts when the body stalls", async () => {
    const stalled = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("a")); } }));
    await expect(routes.readBodyWithLimit(stalled, 1000, 20)).rejects.toMatchObject({ status: 504 });
  });
  it("readBodyWithLimit aborts past the limit", async () => {
    await expect(routes.readBodyWithLimit(new Response("x".repeat(100)), 10)).rejects.toMatchObject({ status: 413 });
    expect((await routes.readBodyWithLimit(new Response("hello"), 10)).toString()).toBe("hello");
  });
  it("looksLikePdf", () => {
    expect(routes.looksLikePdf("application/octet-stream", Buffer.from("%PDF-1.7 ..."))).toBe(true);
    expect(routes.looksLikePdf("application/pdf", Buffer.from("binary"))).toBe(true);
    expect(routes.looksLikePdf("text/html", Buffer.from("<html>login</html>"))).toBe(false);
    expect(routes.looksLikePdf("application/pdf", Buffer.alloc(0))).toBe(false);
  });
});
