import { describe, it, expect, vi, beforeAll } from "vitest";
import { createHmac } from "node:crypto";

const SECRET = "g2-test-hs256-secret";
let authMiddleware: any;

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
  delete process.env.SKIP_JWT_AUTH;
  delete process.env.COGNITO_USER_POOL_ID;
  delete process.env.COGNITO_CLIENT_ID;
  vi.resetModules();
  ({ authMiddleware } = await import("../../src/api/auth.js"));
});

function b64(o: unknown) {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}
function sign(payload: object, secret = SECRET) {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64(payload);
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}
async function run(token: string) {
  const req: any = { headers: { authorization: `Bearer ${token}` } };
  const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json() { return this; } };
  const next = vi.fn();
  vi.spyOn(console, "error").mockImplementation(() => {});
  await authMiddleware(req, res, next);
  return { req, res, next };
}

describe("authMiddleware HS256", () => {
  it("accepts a correctly signed token", async () => {
    const { req, next } = await run(sign({ sub: "user-1", exp: Math.floor(Date.now() / 1000) + 60 }));
    expect(next).toHaveBeenCalled();
    expect(req.userId).toBe("user-1");
  });

  it("rejects a wrong signature (including different length)", async () => {
    const good = sign({ sub: "user-1" });
    const bad1 = sign({ sub: "user-1" }, "other-secret");
    const bad2 = good.slice(0, good.lastIndexOf(".") + 1) + "abc";
    for (const t of [bad1, bad2]) {
      const { res, next } = await run(t);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    }
  });
});
