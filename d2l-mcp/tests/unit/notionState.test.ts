import { describe, it, expect, beforeAll } from "vitest";
import { signNotionState, verifyNotionState } from "../../src/api/oauth/crypto.js";

describe("Notion OAuth state", () => {
  beforeAll(() => { process.env.OAUTH_SESSION_SECRET = "test-secret"; });

  it("round-trips the user id", () => {
    expect(verifyNotionState(signNotionState("user-1"))).toBe("user-1");
  });

  it("rejects the legacy unsigned format and tampered payloads", () => {
    const legacy = Buffer.from(JSON.stringify({ userId: "victim", ts: Date.now() })).toString("base64url");
    expect(verifyNotionState(legacy)).toBeNull();
    const [, sig] = signNotionState("attacker").split(".");
    expect(verifyNotionState(`${legacy}.${sig}`)).toBeNull();
  });

  it("rejects expired state", () => {
    expect(verifyNotionState(signNotionState("user-1"), -1)).toBeNull();
  });
});
