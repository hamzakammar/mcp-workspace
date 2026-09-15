/**
 * Read-only, SSRF-hardened web fetcher for course-website ingestion.
 *
 * Guarantees:
 *   - HTTPS only; host must be in the caller's allowed-origins allowlist.
 *   - DNS is resolved and every resolved address is rejected if private / loopback
 *     / link-local / unique-local / reserved (SSRF protection).
 *   - Redirects are followed MANUALLY and only to URLs that are still same-allowed-
 *     origin AND match the discovery allowlist; anything else → blocked.
 *   - Strict per-attempt timeout, bounded retries with backoff, response-size cap.
 *   - Descriptive User-Agent. Never sends cookies/credentials/tokens.
 *   - Authentication is detected and reported honestly as `auth_required`; it is
 *     never bypassed.
 *
 * The fetcher NEVER decides that data is gone — it only reports an outcome. The
 * store layer is responsible for preservation.
 */

import { lookup } from "node:dns/promises";
import net from "node:net";

export type FetchOutcome =
  | "success"        // 2xx with content
  | "empty"          // 2xx but no/blank body (successful-but-empty)
  | "http_error"     // non-2xx (that isn't an auth signal)
  | "auth_required"  // 401/403 or redirect to an SSO/login page
  | "timeout"        // aborted by the per-attempt timeout
  | "network_error"  // DNS/connection failure
  | "too_large"      // exceeded the response-size cap
  | "blocked";       // SSRF / disallowed scheme / origin / redirect target

export interface FetchResult {
  requestedUrl: string;
  finalUrl: string;
  outcome: FetchOutcome;
  httpStatus: number | null;
  contentType: string | null;
  sourceUpdatedAt: string | null; // ISO, from Last-Modified when present
  body: string | null;
  error: string | null;
}

export type LookupFn = (host: string) => Promise<Array<{ address: string }>>;

export interface FetchOptions {
  allowedOrigins: string[];
  allowPatterns: RegExp[];
  timeoutMs?: number;
  maxBytes?: number;
  maxRetries?: number;
  maxRedirects?: number;
  userAgent?: string;
  /** Injectable DNS resolver (defaults to node dns.lookup) — for deterministic tests. */
  lookupFn?: LookupFn;
}

const DEFAULTS = {
  timeoutMs: 10_000,
  maxBytes: 5_000_000, // 5 MB
  maxRetries: 2,
  maxRedirects: 4,
  userAgent: "HorizonBot/1.0 (+read-only course-website ingestion; contact: horizon@hamzaammar.ca)",
  lookupFn: ((host: string) => lookup(host, { all: true })) as LookupFn,
};

/** True if an IP literal is in a private / loopback / link-local / reserved range. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 127) return true;                      // loopback
    if (a === 0) return true;                        // 0.0.0.0/8
    if (a === 169 && b === 254) return true;         // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;         // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true;                       // multicast/reserved 224+
    return false;
  }
  if (net.isIPv6(ip)) {
    const lc = ip.toLowerCase();
    if (lc === "::1" || lc === "::") return true;    // loopback / unspecified
    if (lc.startsWith("fe80")) return true;          // link-local
    if (lc.startsWith("fc") || lc.startsWith("fd")) return true; // unique-local fc00::/7
    // IPv4-mapped ::ffff:a.b.c.d
    const m = lc.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  return true; // not a valid IP literal → treat as unsafe
}

function originOf(u: URL): string {
  return `${u.protocol}//${u.host}`;
}

/**
 * Validate a URL for fetching. Throws a `blocked:<reason>` Error if it fails
 * scheme / origin / allowlist checks. Exported for direct testing.
 * `enforceAllowlist` is false for the initial approved URL (already vetted) and
 * true for redirect targets and discovered links.
 */
export function assertUrlAllowed(
  rawUrl: string,
  allowedOrigins: string[],
  allowPatterns: RegExp[],
  enforceAllowlist: boolean,
): URL {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("blocked:invalid-url");
  }
  if (u.protocol !== "https:") throw new Error("blocked:scheme");
  if (u.username || u.password) throw new Error("blocked:embedded-credentials");
  if (!allowedOrigins.includes(originOf(u))) throw new Error("blocked:origin");
  if (enforceAllowlist && !allowPatterns.some((re) => re.test(u.toString()))) {
    throw new Error("blocked:not-allowlisted");
  }
  return u;
}

/** Resolve DNS and ensure NO resolved address is private/reserved (SSRF guard). */
async function assertHostResolvesPublic(host: string, lookupFn: LookupFn): Promise<void> {
  // A bare IP literal host is checked directly.
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("blocked:private-ip");
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookupFn(host);
  } catch {
    throw new Error("network:dns");
  }
  if (addrs.length === 0) throw new Error("network:dns-empty");
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error("blocked:private-ip");
  }
}

/** Detect an SSO/login redirect or auth page (never bypassed). */
function isAuthRedirect(location: string): boolean {
  const l = location.toLowerCase();
  return l.includes("oidc/login") || l.includes("/login") || l.includes("duosecurity")
    || l.includes("adfs") || l.includes("saml") || l.includes("cas/login")
    || l.includes("auth.uwaterloo") || l.includes("idp");
}

function looksLikeAuthHtml(html: string): boolean {
  return html.includes('id="redirect-parent"') &&
    (html.includes("/oidc/") || html.includes("duosecurity") || html.includes("/login"));
}

async function readCapped(resp: Response, maxBytes: number): Promise<{ text: string; tooLarge: boolean }> {
  const cl = Number(resp.headers.get("content-length") || "0");
  if (cl && cl > maxBytes) return { text: "", tooLarge: true };
  const body = resp.body;
  if (!body) {
    const text = await resp.text();
    return { text, tooLarge: Buffer.byteLength(text) > maxBytes };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return { text: "", tooLarge: true };
      }
      chunks.push(value);
    }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), tooLarge: false };
}

function isTransient(status: number | null): boolean {
  return status === null || status === 429 || (status >= 500 && status <= 599);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a single approved URL read-only, following only allowlisted same-origin
 * redirects, with SSRF protection, timeout, size cap, and bounded retries.
 */
export async function fetchPage(url: string, opts: FetchOptions): Promise<FetchResult> {
  const o = { ...DEFAULTS, ...opts };
  const base: FetchResult = {
    requestedUrl: url, finalUrl: url, outcome: "network_error",
    httpStatus: null, contentType: null, sourceUpdatedAt: null, body: null, error: null,
  };

  let lastErr = "";
  for (let attempt = 0; attempt <= o.maxRetries; attempt++) {
    try {
      const result = await fetchOnce(url, o);
      // Retry only transient outcomes.
      if ((result.outcome === "http_error" || result.outcome === "network_error" || result.outcome === "timeout")
          && isTransient(result.httpStatus) && attempt < o.maxRetries) {
        await delay(250 * (attempt + 1));
        continue;
      }
      return result;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      // Classify hard-blocked reasons immediately (no retry).
      if (lastErr.startsWith("blocked:")) {
        return { ...base, outcome: "blocked", error: lastErr };
      }
      if (attempt < o.maxRetries) { await delay(250 * (attempt + 1)); continue; }
    }
  }
  const outcome: FetchOutcome = lastErr.startsWith("network:") ? "network_error" : "network_error";
  return { ...base, outcome, error: lastErr || "unknown fetch error" };
}

async function fetchOnce(startUrl: string, o: Required<FetchOptions>): Promise<FetchResult> {
  let current = assertUrlAllowed(startUrl, o.allowedOrigins, o.allowPatterns, /*enforceAllowlist*/ false);

  for (let hop = 0; hop <= o.maxRedirects; hop++) {
    await assertHostResolvesPublic(current.hostname, o.lookupFn);

    let resp: Response;
    try {
      resp = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(o.timeoutMs),
        headers: {
          "User-Agent": o.userAgent,
          "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("aborted") || (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError") {
        return { requestedUrl: startUrl, finalUrl: current.toString(), outcome: "timeout", httpStatus: null, contentType: null, sourceUpdatedAt: null, body: null, error: "timeout" };
      }
      return { requestedUrl: startUrl, finalUrl: current.toString(), outcome: "network_error", httpStatus: null, contentType: null, sourceUpdatedAt: null, body: null, error: msg };
    }

    const status = resp.status;
    const lastMod = resp.headers.get("last-modified");
    const sourceUpdatedAt = lastMod ? safeIso(lastMod) : null;

    // Redirects: validate target against origin + allowlist; detect SSO.
    if (status >= 300 && status < 400) {
      const loc = resp.headers.get("location") || "";
      if (!loc) return outcomeResult(startUrl, current.toString(), "http_error", status, "redirect without location");
      const target = new URL(loc, current);
      if (isAuthRedirect(target.toString())) {
        return outcomeResult(startUrl, target.toString(), "auth_required", status, "redirect to login");
      }
      try {
        current = assertUrlAllowed(target.toString(), o.allowedOrigins, o.allowPatterns, /*enforceAllowlist*/ true);
      } catch {
        return outcomeResult(startUrl, target.toString(), "blocked", status, "redirect outside allowlist/origin");
      }
      continue; // follow
    }

    if (status === 401 || status === 403) {
      return outcomeResult(startUrl, current.toString(), "auth_required", status, "authentication required");
    }
    if (status < 200 || status >= 300) {
      return outcomeResult(startUrl, current.toString(), "http_error", status, `http ${status}`);
    }

    // 2xx — read with size cap.
    const contentType = resp.headers.get("content-type");
    const { text, tooLarge } = await readCapped(resp, o.maxBytes);
    if (tooLarge) return outcomeResult(startUrl, current.toString(), "too_large", status, "response exceeded size cap");
    if (looksLikeAuthHtml(text)) {
      return outcomeResult(startUrl, current.toString(), "auth_required", status, "login page returned as 200");
    }
    const trimmed = text.trim();
    return {
      requestedUrl: startUrl,
      finalUrl: current.toString(),
      outcome: trimmed.length === 0 ? "empty" : "success",
      httpStatus: status,
      contentType,
      sourceUpdatedAt,
      body: text,
      error: null,
    };
  }
  return outcomeResult(startUrl, current.toString(), "blocked", null, "too many redirects");
}

function outcomeResult(requestedUrl: string, finalUrl: string, outcome: FetchOutcome, httpStatus: number | null, error: string): FetchResult {
  return { requestedUrl, finalUrl, outcome, httpStatus, contentType: null, sourceUpdatedAt: null, body: null, error };
}

function safeIso(dateStr: string): string | null {
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
