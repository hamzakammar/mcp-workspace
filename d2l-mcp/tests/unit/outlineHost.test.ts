import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../src/browser/BrowserSessionManager.js", () => ({ BrowserSessionManager: {}, NOVNC_ASSET_PATH: "/vnc/assets" }));
vi.mock("../../src/api/auth.js", () => ({ authMiddleware: (_r: any, _s: any, n: any) => n() }));

const { resolveAllowedOutlineHost } = await import("../../src/api/d2lAuthRoutes.js");

describe("resolveAllowedOutlineHost", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it("defaults to the outline site for the default D2L host", () => {
    delete process.env.D2L_HOST;
    expect(resolveAllowedOutlineHost(undefined)).toBe("outline.uwaterloo.ca");
    expect(resolveAllowedOutlineHost("")).toBe("outline.uwaterloo.ca");
  });

  it("accepts the mapped host in any reasonable spelling", () => {
    delete process.env.D2L_HOST;
    expect(resolveAllowedOutlineHost("https://Outline.UWaterloo.ca/viewer/")).toBe("outline.uwaterloo.ca");
  });

  it("rejects anything not derived from an allowed D2L host", () => {
    delete process.env.D2L_HOST;
    for (const h of ["evil.example.com", "169.254.169.254", "localhost", "outline.uwaterloo.ca.evil.com", "user@outline.uwaterloo.ca", 42]) {
      expect(resolveAllowedOutlineHost(h)).toBeNull();
    }
  });

  it("rejects the UW outline host when learn.uwaterloo.ca is not an allowed D2L host", () => {
    process.env.D2L_HOST = "learn.other.edu";
    delete process.env.D2L_ALLOWED_HOSTS;
    expect(resolveAllowedOutlineHost("outline.uwaterloo.ca")).toBeNull();
  });
});
