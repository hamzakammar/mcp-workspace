import { describe, it, expect } from "vitest";
import { isValidRedirectUriForRegistration } from "../../src/api/oauth/crypto.js";

describe("isValidRedirectUriForRegistration", () => {
  it.each([
    "https://app.example.com/cb",
    "http://localhost:3000/cb",
    "http://127.0.0.1:9999/callback",
    "http://[::1]:8080/cb",
    "cursor://anysphere.cursor-retrieval/oauth/callback",
    "vscode://vscode.github-authentication/did-authenticate",
    "com.example.app:/cb",
  ])("accepts %s", (uri) => {
    expect(isValidRedirectUriForRegistration(uri)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "blob:https://example.com/uuid",
    "about:blank",
    "http://evil.example.com/cb",
    "https://app.example.com/cb#frag",
    "not a url",
  ])("rejects %s", (uri) => {
    expect(isValidRedirectUriForRegistration(uri)).toBe(false);
  });
});
