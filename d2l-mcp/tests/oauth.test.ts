/**
 * OAuth 2.1 authorization-server tests.
 *
 * Spins up the real Express OAuth router on an ephemeral port with an in-memory
 * fake for the shared supabase client, and drives the full flow over HTTP:
 * discovery, dynamic registration, redirect-URI validation, PKCE enforcement,
 * single-use/expiring codes, bearer→user resolution, refresh rotation +
 * revocation, and cross-user isolation.
 *
 * The API-key path is validated in the Go gateway (gateway/middleware/auth_test.go);
 * these tests cover the OAuth server implemented in Node.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

// ── Env (read lazily by the OAuth code) ─────────────────────────────────────
process.env.PUBLIC_BASE_URL = "https://horizon.test";
process.env.STUDY_MCP_TOKEN = "test-session-secret-do-not-log";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = "anon-key";

const RESOURCE = "https://horizon.test/mcp";

// ── In-memory fake for src/utils/supabase.ts ────────────────────────────────
// Implements only the query patterns store.ts uses.
const db: Record<string, any[]> = {
  oauth_clients: [],
  oauth_authorization_codes: [],
  oauth_access_tokens: [],
  oauth_refresh_tokens: [],
};

vi.mock("../src/utils/supabase.js", () => {
  function makeQuery(table: string) {
    const q: any = {
      _op: null as null | string,
      _payload: null as any,
      _filters: [] as [string, any][],
      _limit: undefined as number | undefined,
      insert(rec: any) { q._op = "insert"; q._payload = rec; return q; },
      update(obj: any) { q._op = "update"; q._payload = obj; return q; },
      select() { if (!q._op) q._op = "select"; return q; },
      eq(col: string, val: any) { q._filters.push([col, val]); return q; },
      limit(n: number) { q._limit = n; return q; },
      _match(row: any) { return q._filters.every(([c, v]) => row[c] === v); },
      _run() {
        const rows = db[table];
        if (q._op === "insert") {
          db[table].push({ ...q._payload });
          return { data: [q._payload], error: null };
        }
        if (q._op === "update") {
          const matched = rows.filter((r) => q._match(r));
          for (const r of matched) Object.assign(r, q._payload);
          return { data: matched.map((r) => ({ ...r })), error: null };
        }
        let out = rows.filter((r) => q._match(r));
        if (q._limit != null) out = out.slice(0, q._limit);
        return { data: out.map((r) => ({ ...r })), error: null };
      },
      then(resolve: any) { resolve(q._run()); },
    };
    return q;
  }
  return { supabase: { from: (table: string) => makeQuery(table) } };
});

// ── Fake @supabase/supabase-js for the authorize login step ─────────────────
const USERS: Record<string, string> = {
  "alice@horizon.test": "11111111-1111-1111-1111-111111111111",
  "bob@horizon.test": "22222222-2222-2222-2222-222222222222",
};
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
        const id = USERS[email];
        if (id && password === "correct-horse") return { data: { user: { id } }, error: null };
        return { data: { user: null }, error: { message: "Invalid login credentials" } };
      },
    },
  }),
}));

// Imported AFTER mocks are registered.
const express = (await import("express")).default;
const oauthRoutes = (await import("../src/api/oauth/index.js")).default;
const store = await import("../src/api/oauth/store.js");
const { sha256hex, verifyPkceS256 } = await import("../src/api/oauth/crypto.js");

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/", oauthRoutes);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── tiny HTTP client that does NOT follow redirects ─────────────────────────
function req(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(base + path, { method, headers: opts.headers || {} }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, text }));
    });
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

function form(obj: Record<string, string>): { headers: Record<string, string>; body: string } {
  return {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(obj).toString(),
  };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function registerClient(redirectUris = ["http://127.0.0.1:9999/callback"]) {
  const r = await req("POST", "/register", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test Client", redirect_uris: redirectUris }),
  });
  expect(r.status).toBe(201);
  return JSON.parse(r.text);
}

/** Complete authorize (GET consent → POST login) and return the code. */
async function getAuthCode(clientId: string, redirectUri: string, challenge: string, email: string) {
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "horizon:mcp",
    state: "st-123",
    resource: RESOURCE,
  });
  const page = await req("GET", `/authorize?${qs.toString()}`);
  expect(page.status).toBe(200);
  const m = page.text.match(/name="auth_request" value="([^"]+)"/);
  expect(m).toBeTruthy();
  const authRequest = m![1];

  const post = await req(
    "POST",
    "/authorize",
    form({ auth_request: authRequest, email, password: "correct-horse" })
  );
  expect(post.status).toBe(302);
  const loc = new URL(post.headers.location as string);
  expect(loc.searchParams.get("state")).toBe("st-123");
  const code = loc.searchParams.get("code");
  expect(code).toBeTruthy();
  return code!;
}

async function exchangeCode(clientId: string, code: string, redirectUri: string, verifier: string) {
  return req(
    "POST",
    "/token",
    form({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    })
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("discovery metadata", () => {
  it("serves valid protected-resource metadata", async () => {
    const r = await req("GET", "/.well-known/oauth-protected-resource");
    expect(r.status).toBe(200);
    const m = JSON.parse(r.text);
    expect(m.resource).toBe(RESOURCE);
    expect(m.authorization_servers).toContain("https://horizon.test");
    expect(m.scopes_supported).toContain("horizon:mcp");
  });

  it("serves valid authorization-server metadata with S256 + DCR", async () => {
    const r = await req("GET", "/.well-known/oauth-authorization-server");
    expect(r.status).toBe(200);
    const m = JSON.parse(r.text);
    expect(m.issuer).toBe("https://horizon.test");
    expect(m.authorization_endpoint).toBe("https://horizon.test/authorize");
    expect(m.token_endpoint).toBe("https://horizon.test/token");
    expect(m.registration_endpoint).toBe("https://horizon.test/register");
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.grant_types_supported).toContain("refresh_token");
  });
});

describe("dynamic client registration", () => {
  it("registers a public PKCE client with no secret", async () => {
    const c = await registerClient();
    expect(c.client_id).toMatch(/^hzn_client_/);
    expect(c.token_endpoint_auth_method).toBe("none");
    expect(c.client_secret).toBeUndefined();
  });

  it("rejects invalid redirect URIs", async () => {
    const r = await req("POST", "/register", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"] }),
    });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error).toBe("invalid_redirect_uri");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "blob:https://horizon.test/abc",
    "about:blank",
  ])("rejects dangerous redirect scheme %s", async (uri) => {
    const r = await req("POST", "/register", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [uri] }),
    });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error).toBe("invalid_redirect_uri");
  });

  it("still accepts custom app schemes", async () => {
    const c = await registerClient(["cursor://anysphere.cursor-retrieval/oauth/callback", "com.example.app:/cb"]);
    expect(c.redirect_uris).toHaveLength(2);
  });

  it("rejects a missing redirect_uris array", async () => {
    const r = await req("POST", "/register", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "x" }),
    });
    expect(r.status).toBe(400);
  });
});

describe("authorization endpoint", () => {
  it("requires PKCE S256 (redirects with invalid_request when missing)", async () => {
    const c = await registerClient();
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: c.client_id,
      redirect_uri: c.redirect_uris[0],
      scope: "horizon:mcp",
      state: "s",
    });
    const r = await req("GET", `/authorize?${qs.toString()}`);
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.location as string);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
  });

  it("rejects an unregistered redirect_uri without redirecting", async () => {
    const c = await registerClient();
    const { challenge } = pkce();
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: c.client_id,
      redirect_uri: "http://127.0.0.1:9999/EVIL",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const r = await req("GET", `/authorize?${qs.toString()}`);
    expect(r.status).toBe(400);
    expect(r.headers.location).toBeUndefined();
  });

  it("shows the redirect destination host on the consent page", async () => {
    const c = await registerClient(["https://app.example.com/oauth/cb?x=1"]);
    const { challenge } = pkce();
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: c.client_id,
      redirect_uri: c.redirect_uris[0],
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const page = await req("GET", `/authorize?${qs.toString()}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('<span class="dest">app.example.com</span>');
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
  });

  it("refuses a previously registered javascript: redirect URI", async () => {
    const clientId = "hzn_client_legacy_" + randomBytes(4).toString("hex");
    await store.createClient({
      client_id: clientId,
      client_secret_hash: null,
      client_name: "legacy",
      redirect_uris: ["javascript:alert(1)"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "horizon:mcp",
      token_endpoint_auth_method: "none",
    });
    // The fake stores JSON strings; getClient parses them back.
    const { challenge } = pkce();
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "javascript:alert(1)",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const r = await req("GET", `/authorize?${qs.toString()}`);
    expect(r.status).toBe(400);
    expect(r.headers.location).toBeUndefined();
  });

  it("returns 500 instead of hanging when the client lookup throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const orig = db.oauth_clients;
    // Make the select blow up by replacing the table with a throwing proxy.
    (db as any).oauth_clients = new Proxy([], { get() { throw new Error("db down"); } });
    try {
      const r = await req(
        "POST",
        "/token",
        form({ grant_type: "refresh_token", refresh_token: "x", client_id: "whatever" })
      );
      expect(r.status).toBe(500);
      expect(JSON.parse(r.text).error).toBe("server_error");
    } finally {
      db.oauth_clients = orig;
      spy.mockRestore();
    }
  });

  it("rejects bad credentials on the consent POST", async () => {
    const c = await registerClient();
    const { challenge } = pkce();
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: c.client_id,
      redirect_uri: c.redirect_uris[0],
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "horizon:mcp",
    });
    const page = await req("GET", `/authorize?${qs.toString()}`);
    const authRequest = page.text.match(/name="auth_request" value="([^"]+)"/)![1];
    const post = await req(
      "POST",
      "/authorize",
      form({ auth_request: authRequest, email: "alice@horizon.test", password: "wrong" })
    );
    // Re-renders the consent page with an error, does not issue a code.
    expect(post.status).toBe(200);
    expect(post.text).toContain("Invalid email or password");
  });
});

describe("token endpoint", () => {
  it("issues a bearer token that resolves to the correct Horizon user", async () => {
    const c = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await getAuthCode(c.client_id, c.redirect_uris[0], challenge, "alice@horizon.test");
    const r = await exchangeCode(c.client_id, code, c.redirect_uris[0], verifier);
    expect(r.status).toBe(200);
    const tok = JSON.parse(r.text);
    expect(tok.access_token).toMatch(/^hzn_at_/);
    expect(tok.refresh_token).toMatch(/^hzn_rt_/);
    expect(tok.token_type).toBe("Bearer");
    expect(tok.expires_in).toBeGreaterThan(0);

    const row = await store.getAccessToken(sha256hex(tok.access_token));
    expect(row?.user_id).toBe(USERS["alice@horizon.test"]);
    expect(row?.resource).toBe(RESOURCE);
  });

  it("makes authorization codes single-use", async () => {
    const c = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await getAuthCode(c.client_id, c.redirect_uris[0], challenge, "alice@horizon.test");

    const first = await exchangeCode(c.client_id, code, c.redirect_uris[0], verifier);
    expect(first.status).toBe(200);

    const second = await exchangeCode(c.client_id, code, c.redirect_uris[0], verifier);
    expect(second.status).toBe(400);
    expect(JSON.parse(second.text).error).toBe("invalid_grant");
  });

  it("rejects an expired authorization code", async () => {
    const c = await registerClient();
    const { verifier, challenge } = pkce();
    const rawCode = "hzn_ac_expired_" + randomBytes(8).toString("hex");
    await store.saveAuthCode({
      code_hash: sha256hex(rawCode),
      client_id: c.client_id,
      user_id: USERS["alice@horizon.test"],
      redirect_uri: c.redirect_uris[0],
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "horizon:mcp",
      resource: RESOURCE,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const r = await exchangeCode(c.client_id, rawCode, c.redirect_uris[0], verifier);
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error).toBe("invalid_grant");
  });

  it("rejects a wrong PKCE verifier", async () => {
    const c = await registerClient();
    const { challenge } = pkce();
    const code = await getAuthCode(c.client_id, c.redirect_uris[0], challenge, "alice@horizon.test");
    const wrong = randomBytes(32).toString("base64url");
    const r = await exchangeCode(c.client_id, code, c.redirect_uris[0], wrong);
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error).toBe("invalid_grant");
  });

  it("rejects a redirect_uri mismatch at token time", async () => {
    const c = await registerClient(["http://127.0.0.1:9999/callback", "http://127.0.0.1:9999/other"]);
    const { verifier, challenge } = pkce();
    const code = await getAuthCode(c.client_id, "http://127.0.0.1:9999/callback", challenge, "alice@horizon.test");
    const r = await exchangeCode(c.client_id, code, "http://127.0.0.1:9999/other", verifier);
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error).toBe("invalid_grant");
  });
});

describe("refresh token rotation + revocation", () => {
  it("rotates the refresh token and invalidates the old one", async () => {
    const c = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await getAuthCode(c.client_id, c.redirect_uris[0], challenge, "alice@horizon.test");
    const first = JSON.parse((await exchangeCode(c.client_id, code, c.redirect_uris[0], verifier)).text);

    const refreshed = await req(
      "POST",
      "/token",
      form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: c.client_id })
    );
    expect(refreshed.status).toBe(200);
    const rot = JSON.parse(refreshed.text);
    expect(rot.access_token).toMatch(/^hzn_at_/);
    expect(rot.refresh_token).not.toBe(first.refresh_token);

    // Old refresh token is now revoked.
    const reuse = await req(
      "POST",
      "/token",
      form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: c.client_id })
    );
    expect(reuse.status).toBe(400);
    expect(JSON.parse(reuse.text).error).toBe("invalid_grant");
  });

  it("allows exactly one of two concurrent refreshes with the same token", async () => {
    const c = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await getAuthCode(c.client_id, c.redirect_uris[0], challenge, "alice@horizon.test");
    const first = JSON.parse((await exchangeCode(c.client_id, code, c.redirect_uris[0], verifier)).text);

    const body = form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: c.client_id });
    const results = await Promise.all([req("POST", "/token", body), req("POST", "/token", body)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 400]);
    expect(JSON.parse(results.find((r) => r.status === 400)!.text).error).toBe("invalid_grant");

    // Benign double-refresh: the winner's tokens must remain valid.
    const win = JSON.parse(results.find((r) => r.status === 200)!.text);
    expect((await store.getAccessToken(sha256hex(win.access_token)))?.revoked).toBe(false);
    expect((await store.getRefreshToken(sha256hex(win.refresh_token)))?.revoked).toBe(false);
    const next = await req(
      "POST",
      "/token",
      form({ grant_type: "refresh_token", refresh_token: win.refresh_token, client_id: c.client_id })
    );
    expect(next.status).toBe(200);
  });

  it("refuses a replay inside the grace window without revoking the family", async () => {
    const c = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await getAuthCode(c.client_id, c.redirect_uris[0], challenge, "alice@horizon.test");
    const first = JSON.parse((await exchangeCode(c.client_id, code, c.redirect_uris[0], verifier)).text);
    const body = form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: c.client_id });

    const rot = JSON.parse((await req("POST", "/token", body)).text);
    const replay = await req("POST", "/token", body);
    expect(replay.status).toBe(400);
    expect(JSON.parse(replay.text).error).toBe("invalid_grant");
    expect((await store.getRefreshToken(sha256hex(rot.refresh_token)))?.revoked).toBe(false);
    expect((await store.getAccessToken(sha256hex(rot.access_token)))?.revoked).toBe(false);
  });

  it("serializes refresh-token consumption at the store level", async () => {
    const hash = sha256hex("hzn_rt_race_" + randomBytes(8).toString("hex"));
    await store.saveRefreshToken({
      token_hash: hash,
      client_id: "c-race",
      user_id: USERS["alice@horizon.test"],
      scope: "horizon:mcp",
      resource: RESOURCE,
      rotated_from: null,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const [a, b] = await Promise.all([store.consumeRefreshToken(hash), store.consumeRefreshToken(hash)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await store.getRefreshToken(hash))?.revoked).toBe(true);
  });

  it("revokes the whole token family when a rotated refresh token is replayed after the grace window", async () => {
    const c = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await getAuthCode(c.client_id, c.redirect_uris[0], challenge, "alice@horizon.test");
    const first = JSON.parse((await exchangeCode(c.client_id, code, c.redirect_uris[0], verifier)).text);

    const rot = JSON.parse(
      (
        await req(
          "POST",
          "/token",
          form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: c.client_id })
        )
      ).text
    );
    // Move the rotation outside the grace window, then replay the old token.
    const child = db.oauth_refresh_tokens.find((r) => r.token_hash === sha256hex(rot.refresh_token));
    child.created_at = new Date(Date.now() - 60_000).toISOString();
    const replay = await req(
      "POST",
      "/token",
      form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: c.client_id })
    );
    expect(replay.status).toBe(400);

    // The descendant tokens are now revoked too.
    expect((await store.getRefreshToken(sha256hex(rot.refresh_token)))?.revoked).toBe(true);
    expect((await store.getAccessToken(sha256hex(rot.access_token)))?.revoked).toBe(true);
    const again = await req(
      "POST",
      "/token",
      form({ grant_type: "refresh_token", refresh_token: rot.refresh_token, client_id: c.client_id })
    );
    expect(again.status).toBe(400);
  });

  it("does not let another client revoke a token (RFC 7009: 200, no-op)", async () => {
    const owner = await registerClient();
    const other = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await getAuthCode(owner.client_id, owner.redirect_uris[0], challenge, "alice@horizon.test");
    const tok = JSON.parse((await exchangeCode(owner.client_id, code, owner.redirect_uris[0], verifier)).text);

    const r1 = await req("POST", "/revoke", form({ token: tok.access_token, client_id: other.client_id }));
    expect(r1.status).toBe(200);
    expect((await store.getAccessToken(sha256hex(tok.access_token)))?.revoked).toBe(false);

    const r2 = await req(
      "POST",
      "/revoke",
      form({ token: tok.refresh_token, token_type_hint: "refresh_token", client_id: other.client_id })
    );
    expect(r2.status).toBe(200);
    expect((await store.getRefreshToken(sha256hex(tok.refresh_token)))?.revoked).toBe(false);
  });

  it("revoking a refresh token also revokes the client's access tokens for that user", async () => {
    const c = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await getAuthCode(c.client_id, c.redirect_uris[0], challenge, "alice@horizon.test");
    const tok = JSON.parse((await exchangeCode(c.client_id, code, c.redirect_uris[0], verifier)).text);

    const rev = await req(
      "POST",
      "/revoke",
      form({ token: tok.refresh_token, token_type_hint: "refresh_token", client_id: c.client_id })
    );
    expect(rev.status).toBe(200);
    expect((await store.getRefreshToken(sha256hex(tok.refresh_token)))?.revoked).toBe(true);
    expect((await store.getAccessToken(sha256hex(tok.access_token)))?.revoked).toBe(true);
  });

  it("rolls back refresh-token consumption when issuing the new pair fails", async () => {
    const c = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await getAuthCode(c.client_id, c.redirect_uris[0], challenge, "alice@horizon.test");
    const first = JSON.parse((await exchangeCode(c.client_id, code, c.redirect_uris[0], verifier)).text);
    const body = form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: c.client_id });

    const accessBefore = db.oauth_access_tokens.length;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const arr = db.oauth_refresh_tokens;
    const origPush = arr.push;
    arr.push = function () {
      arr.push = origPush;
      throw new Error("db down");
    } as any;
    try {
      const failed = await req("POST", "/token", body);
      expect(failed.status).toBe(500);
    } finally {
      arr.push = origPush;
      spy.mockRestore();
    }
    // Old refresh token is usable again; the orphaned access token is revoked.
    expect((await store.getRefreshToken(sha256hex(first.refresh_token)))?.revoked).toBe(false);
    const orphans = db.oauth_access_tokens.slice(accessBefore);
    expect(orphans.length).toBe(1);
    expect(orphans[0].revoked).toBe(true);

    const retry = await req("POST", "/token", body);
    expect(retry.status).toBe(200);
  });

  it("returns 503 from /revoke when the client lookup fails (no possession-only fallback)", async () => {
    const c = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await getAuthCode(c.client_id, c.redirect_uris[0], challenge, "alice@horizon.test");
    const tok = JSON.parse((await exchangeCode(c.client_id, code, c.redirect_uris[0], verifier)).text);

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const orig = db.oauth_clients;
    (db as any).oauth_clients = new Proxy([], { get() { throw new Error("db down"); } });
    try {
      const r = await req("POST", "/revoke", form({ token: tok.access_token, client_id: c.client_id }));
      expect(r.status).toBe(503);
    } finally {
      db.oauth_clients = orig;
      spy.mockRestore();
    }
    expect((await store.getAccessToken(sha256hex(tok.access_token)))?.revoked).toBe(false);
  });

  it("revokes an access token via /revoke", async () => {
    const c = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await getAuthCode(c.client_id, c.redirect_uris[0], challenge, "alice@horizon.test");
    const tok = JSON.parse((await exchangeCode(c.client_id, code, c.redirect_uris[0], verifier)).text);

    const rev = await req("POST", "/revoke", form({ token: tok.access_token, client_id: c.client_id }));
    expect(rev.status).toBe(200);

    const row = await store.getAccessToken(sha256hex(tok.access_token));
    expect(row?.revoked).toBe(true);
  });
});

describe("cross-user isolation", () => {
  it("issues distinct tokens that resolve to their own user only", async () => {
    const c = await registerClient();

    const a = pkce();
    const codeA = await getAuthCode(c.client_id, c.redirect_uris[0], a.challenge, "alice@horizon.test");
    const tokA = JSON.parse((await exchangeCode(c.client_id, codeA, c.redirect_uris[0], a.verifier)).text);

    const b = pkce();
    const codeB = await getAuthCode(c.client_id, c.redirect_uris[0], b.challenge, "bob@horizon.test");
    const tokB = JSON.parse((await exchangeCode(c.client_id, codeB, c.redirect_uris[0], b.verifier)).text);

    const rowA = await store.getAccessToken(sha256hex(tokA.access_token));
    const rowB = await store.getAccessToken(sha256hex(tokB.access_token));

    expect(rowA?.user_id).toBe(USERS["alice@horizon.test"]);
    expect(rowB?.user_id).toBe(USERS["bob@horizon.test"]);
    expect(rowA?.user_id).not.toBe(rowB?.user_id);
    // Alice's token never resolves to Bob.
    expect(rowA?.user_id).not.toBe(USERS["bob@horizon.test"]);
  });
});

describe("pkce helper", () => {
  it("accepts a correct S256 verifier and rejects others", () => {
    const { verifier, challenge } = pkce();
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256("short", challenge)).toBe(false);
    expect(verifyPkceS256(randomBytes(32).toString("base64url"), challenge)).toBe(false);
  });
});
