/**
 * Pure / easily-testable helpers used by the MCP HTTP server in index.ts:
 * session persistence + ownership, per-user transport caps, serialized file
 * writes, in-flight dedupe, a bounded TTL cache, deadline sorting, tool-output
 * truncation, and PostgREST Content-Range parsing.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import fsDefault from "node:fs/promises";

// ---------------------------------------------------------------------------
// Stateless, user-bound session ids
// ---------------------------------------------------------------------------
//
// ECS tasks have no persistent disk, so the session file is empty after every
// deploy. New session ids therefore carry their own proof of ownership:
//   `${uuid}.${base64url(HMAC-SHA256(secret, "mcp-session|" + uuid + "|" + userId)).slice(0, 22)}`
// so any task can verify that a presented id was issued to the requesting user.

const SIG_LEN = 22;
const SIGNED_ID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{22})$/i;

/** Secret used to sign session ids (same fallback chain as the OAuth config). */
export function resolveSessionSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.MCP_SESSION_SECRET || env.OAUTH_SESSION_SECRET || env.STUDY_MCP_TOKEN || null;
}

function sessionSig(secret: string, uuid: string, userId: string): string {
  return createHmac("sha256", secret)
    .update(`mcp-session|${uuid}|${userId}`)
    .digest("base64url")
    .slice(0, SIG_LEN);
}

/** New session id: signed for `userId` when a secret is available, else a plain uuid. */
export function generateSessionId(userId: string, secret: string | null, uuid: string = randomUUID()): string {
  return secret ? `${uuid}.${sessionSig(secret, uuid, userId)}` : uuid;
}

export type SignedIdCheck = "valid" | "mismatch" | "unsigned";

/** Verify a signed session id for `userId` (constant-time). */
export function verifySessionId(sessionId: string, userId: string, secret: string | null): SignedIdCheck {
  const m = SIGNED_ID_RE.exec(sessionId);
  if (!m || !secret) return "unsigned";
  const expected = Buffer.from(sessionSig(secret, m[1], userId));
  const actual = Buffer.from(m[2]);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? "valid" : "mismatch";
}

// ---------------------------------------------------------------------------
// Session persistence (sessionId -> owning userId)
// ---------------------------------------------------------------------------

export interface PersistedSession {
  /** Owning user, or null for a legacy (pre-ownership) id not yet claimed. */
  userId: string | null;
  lastSeen: number;
}

export type SessionMap = Map<string, PersistedSession>;

/**
 * Parse the on-disk session file.
 *
 * Current format: `{ "version": 2, "sessions": { [sid]: { userId, lastSeen } } }`.
 * Legacy format: a bare array of session ids with no owner. Those are kept
 * as unclaimed (`userId: null`) and bound trust-on-first-use by
 * `claimOrCheckSession`; unclaimed ones age out via `pruneSessions`.
 */
export function parsePersistedSessions(
  raw: unknown,
  now: number = Date.now()
): { sessions: SessionMap; migratedLegacy: number } {
  const sessions: SessionMap = new Map();
  if (Array.isArray(raw)) {
    for (const sid of raw) {
      if (typeof sid === "string" && sid) sessions.set(sid, { userId: null, lastSeen: now });
    }
    return { sessions, migratedLegacy: sessions.size };
  }
  if (raw && typeof raw === "object") {
    const obj = (raw as { sessions?: unknown }).sessions;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const [sid, v] of Object.entries(obj as Record<string, unknown>)) {
        if (!v || typeof v !== "object") continue;
        const userId = (v as { userId?: unknown }).userId;
        const lastSeen = (v as { lastSeen?: unknown }).lastSeen;
        // null = migrated legacy id still awaiting its first claim
        if (userId !== null && (typeof userId !== "string" || !userId)) continue;
        sessions.set(sid, {
          userId,
          lastSeen: typeof lastSeen === "number" && Number.isFinite(lastSeen) ? lastSeen : now,
        });
      }
    }
  }
  return { sessions, migratedLegacy: 0 };
}

export function serializeSessions(sessions: SessionMap): string {
  const out: Record<string, PersistedSession> = {};
  for (const [sid, v] of sessions) out[sid] = { userId: v.userId, lastSeen: v.lastSeen };
  return JSON.stringify({ version: 2, sessions: out }, null, 2);
}

/** A session id may only be used (restored or reused) by the user it was issued to. */
export function sessionBelongsTo(sessions: SessionMap, sessionId: string, userId: string): boolean {
  const s = sessions.get(sessionId);
  return !!s && s.userId === userId;
}

/**
 * Ownership check with trust-on-first-use for migrated legacy ids: the first
 * authenticated request carrying an unclaimed id binds it to that user (the
 * caller should persist when `claimed` is true); afterwards only that user
 * may use it.
 */
export function claimOrCheckSession(
  sessions: SessionMap,
  sessionId: string,
  userId: string
): { ok: boolean; claimed: boolean } {
  const s = sessions.get(sessionId);
  if (!s) return { ok: false, claimed: false };
  if (s.userId === null) {
    s.userId = userId;
    return { ok: true, claimed: true };
  }
  return { ok: s.userId === userId, claimed: false };
}

/**
 * Full ownership resolution for a presented session id:
 * - signed id (and a secret is configured): the HMAC is authoritative —
 *   valid for this user → ok (recorded in the map so the file mirrors it);
 *   otherwise → not ok, regardless of the file.
 * - unsigned id: file-based ownership with TOFU for migrated legacy ids.
 * `changed` tells the caller the map was modified and should be persisted.
 */
export function resolveSessionOwnership(
  sessions: SessionMap,
  sessionId: string,
  userId: string,
  secret: string | null,
  now: number = Date.now()
): { ok: boolean; changed: boolean } {
  const signed = verifySessionId(sessionId, userId, secret);
  if (signed === "mismatch") return { ok: false, changed: false };
  if (signed === "valid") {
    const s = sessions.get(sessionId);
    if (s && s.userId === userId) return { ok: true, changed: false };
    sessions.set(sessionId, { userId, lastSeen: s?.lastSeen ?? now });
    return { ok: true, changed: true };
  }
  const r = claimOrCheckSession(sessions, sessionId, userId);
  return { ok: r.ok, changed: r.claimed };
}

/**
 * Remove persisted sessions not seen within `ttlMs`, except ones that still
 * have a live transport. Returns the number removed.
 */
export function pruneSessions(
  sessions: SessionMap,
  now: number,
  ttlMs: number,
  isLive: (sid: string) => boolean
): number {
  let removed = 0;
  for (const [sid, s] of sessions) {
    if (isLive(sid)) continue;
    if (now - s.lastSeen > ttlMs) {
      sessions.delete(sid);
      removed++;
    }
  }
  return removed;
}

/**
 * Given the live session ids owned by `userId`, return the idle ids to evict
 * (oldest lastSeen first) so that adding one more transport keeps the user at
 * or below `cap`.
 */
export function pickEvictions(
  liveSessionIds: string[],
  lastSeen: (sid: string) => number,
  cap: number,
  isBusy: (sid: string) => boolean = () => false
): string[] {
  const excess = liveSessionIds.length - (cap - 1);
  if (excess <= 0) return [];
  // Never evict a transport with an in-flight request or open SSE stream;
  // if everything is busy the cap is exceeded temporarily.
  return liveSessionIds
    .filter((sid) => !isBusy(sid))
    .sort((a, b) => lastSeen(a) - lastSeen(b))
    .slice(0, excess);
}

// ---------------------------------------------------------------------------
// Serialized atomic file writes
// ---------------------------------------------------------------------------

type FsLike = Pick<typeof fsDefault, "writeFile" | "rename">;

/**
 * Writes are performed one at a time (temp file + rename, so readers never see
 * a half-written file). Writes requested while one is in flight are coalesced:
 * only the latest content is written next.
 */
export class SerializedFileWriter {
  private writing: Promise<void> | null = null;
  private pending: string | null = null;
  private waiters: Array<() => void> = [];

  constructor(private readonly file: string, private readonly fs: FsLike = fsDefault) {}

  write(content: string): Promise<void> {
    this.pending = content;
    const done = new Promise<void>((resolve) => this.waiters.push(resolve));
    if (!this.writing) this.writing = this.drain();
    return done;
  }

  private async drain(): Promise<void> {
    while (this.pending !== null) {
      const content = this.pending;
      const waiters = this.waiters;
      this.pending = null;
      this.waiters = [];
      const tmp = `${this.file}.${process.pid}.tmp`;
      try {
        await this.fs.writeFile(tmp, content);
        await this.fs.rename(tmp, this.file);
      } catch (error) {
        console.error("[SESSION] Failed to save sessions:", error);
      }
      for (const w of waiters) w();
    }
    this.writing = null;
  }
}

// ---------------------------------------------------------------------------
// In-flight dedupe
// ---------------------------------------------------------------------------

/** Run `factory` once per key at a time; concurrent callers share the promise. */
export function dedupeInFlight<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  factory: () => Promise<T>
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = (async () => factory())().finally(() => {
    if (inFlight.get(key) === p) inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// Bounded TTL cache
// ---------------------------------------------------------------------------

export class BoundedTtlCache<V> {
  private map = new Map<string, { value: V; at: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (this.now() - e.at >= this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V): void {
    const t = this.now();
    this.map.delete(key);
    // Drop expired entries, then the oldest ones if still over capacity.
    for (const [k, e] of this.map) if (t - e.at >= this.ttlMs) this.map.delete(k);
    while (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, at: t });
  }

  get size(): number {
    return this.map.size;
  }
}

// ---------------------------------------------------------------------------
// Deadlines / tool output / PostgREST helpers
// ---------------------------------------------------------------------------

/** Sort (in place) by the raw due timestamp; unparsable dates go last. */
export function sortByDueAt<T extends { dueAt: string }>(items: T[]): T[] {
  const key = (s: string) => {
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
  };
  return items.sort((a, b) => {
    const ka = key(a.dueAt);
    const kb = key(b.dueAt);
    if (ka === kb) return 0;
    return ka < kb ? -1 : 1;
  });
}

export const MAX_TOOL_FILE_CHARS = 100_000;

export function truncateForToolResult(text: string, max: number = MAX_TOOL_FILE_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated: ${max} of ${text.length} characters shown]`;
}

/** Parse the total from a PostgREST Content-Range header ("0-0/123", "*\/0"). */
export function parseContentRangeTotal(header: string | null | undefined): number | null {
  if (!header) return null;
  const m = /\/(\d+)\s*$/.exec(header);
  return m ? parseInt(m[1], 10) : null;
}
