/**
 * d2lHost.ts — single source of truth for which D2L Brightspace hosts the
 * server is willing to talk to.
 *
 * The D2L host is user-supplied (onboarding / connect endpoints) and is later
 * used to build server-side fetch URLs and to drive headless browser logins.
 * Without an allowlist, a user could store `attacker.com` or an internal IP
 * and turn the server into an SSRF proxy. Every place that persists or uses a
 * host must go through these helpers.
 *
 * Configuration:
 *   D2L_HOST           — default host when a user has none stored
 *                        (falls back to learn.uwaterloo.ca)
 *   D2L_ALLOWED_HOSTS  — optional comma-separated list of extra allowed hosts.
 *                        DEFAULT_D2L_HOST is always allowed.
 */

const FALLBACK_HOST = "learn.uwaterloo.ca";

/** Lower-cased bare hostname (no scheme, path, port, or trailing dot). */
function bare(raw: string): string {
  return raw
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

export const DEFAULT_D2L_HOST: string = bare(process.env.D2L_HOST || "") || FALLBACK_HOST;

/** The set of allowed hosts, re-read from env on each call so tests can override. */
export function getAllowedD2LHosts(): Set<string> {
  const hosts = new Set<string>([bare(process.env.D2L_HOST || "") || FALLBACK_HOST]);
  for (const h of (process.env.D2L_ALLOWED_HOSTS || "").split(",")) {
    const b = bare(h);
    if (b) hosts.add(b);
  }
  return hosts;
}

/**
 * Normalize a user-supplied host ("https://Learn.UWaterloo.ca/d2l/home" →
 * "learn.uwaterloo.ca"). Returns null if the result is not a syntactically
 * valid DNS hostname (rejects IP literals, userinfo, empty strings).
 */
export function normalizeD2LHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (/[@\s\\]/.test(raw.trim())) return null;
  const host = bare(raw);
  if (!host || host.length > 253) return null;
  // DNS name with at least one dot; each label 1-63 chars of [a-z0-9-], no leading/trailing hyphen.
  const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => label.test(l))) return null;
  // Reject all-numeric hosts (IPv4 literals like 10.0.0.1).
  if (labels.every((l) => /^\d+$/.test(l))) return null;
  return host;
}

/** True when `raw` normalizes to a host on the allowlist. */
export function isAllowedD2LHost(raw: unknown): boolean {
  const host = normalizeD2LHost(raw);
  return host !== null && getAllowedD2LHosts().has(host);
}

/**
 * Normalize + allowlist check in one step. Returns the canonical host, or null
 * if the value is missing, malformed, or not allowed.
 */
export function resolveAllowedD2LHost(raw: unknown): string | null {
  const host = normalizeD2LHost(raw);
  return host !== null && getAllowedD2LHosts().has(host) ? host : null;
}
