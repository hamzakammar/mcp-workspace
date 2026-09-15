/**
 * Course-website ingestion connector — unit tests.
 *
 * Deterministic: inline HTML fixtures + stubbed global fetch + injected DNS
 * resolver. No live network is required for the normal suite.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Keep the normal suite off the network: the connector's default DNS resolver is
// mocked to a fixed public UW address so no real DNS lookups occur.
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "142.150.1.1", family: 4 }],
}));

// Supabase is mocked with a small recording fake (configured per test).
const db = {
  latestSnapshot: null as null | { id: string; content_hash: string | null },
  existingItem: null as null | { id: string; due_at: string | null; conflicts: unknown[]; first_seen_at: string },
  otherTasks: [] as Array<{ title: string; due_at: string | null; source: string }>,
  canonicalItems: [] as unknown[],
  snapshots: [] as unknown[],
  recorded: [] as Array<{ table: string; op: string; row?: any; filters: Record<string, unknown> }>,
};
function resetDb() {
  db.latestSnapshot = null; db.existingItem = null; db.otherTasks = [];
  db.canonicalItems = []; db.snapshots = []; db.recorded = [];
}

vi.mock("../../src/utils/supabase.js", () => {
  function makeQuery(table: string) {
    const state = { table, op: "select", row: undefined as any, filters: {} as Record<string, unknown> };
    const resolve = async () => {
      db.recorded.push({ table, op: state.op, row: state.row, filters: { ...state.filters } });
      if (state.op === "insert") return { data: { id: "snap-new" }, error: null };
      if (state.op === "upsert") return { data: null, error: null };
      // selects
      if (table === "course_website_snapshots") {
        if (state.filters.__latest) return { data: db.latestSnapshot, error: null };
        return { data: db.snapshots, error: null };
      }
      if (table === "course_website_items") {
        if (state.filters.source_ref !== undefined) return { data: db.existingItem, error: null };
        return { data: db.canonicalItems, error: null };
      }
      if (table === "tasks") return { data: db.otherTasks, error: null };
      return { data: null, error: null };
    };
    const q: any = {};
    q.select = () => q;
    q.eq = (k: string, v: unknown) => { state.filters[k] = v; return q; };
    q.neq = (k: string, v: unknown) => { state.filters[`neq_${k}`] = v; return q; };
    q.order = () => q;
    q.limit = () => q;
    q.insert = (row: any) => { state.op = "insert"; state.row = row; return q; };
    q.upsert = (row: any) => { state.op = "upsert"; state.row = row; return q; };
    q.maybeSingle = () => { if (table === "course_website_snapshots" && state.op === "select") state.filters.__latest = true; return resolve(); };
    q.then = (res: any, rej: any) => resolve().then(res, rej);
    return q;
  }
  return { supabase: { from: (t: string) => makeQuery(t) } };
});

import {
  isPrivateIp, assertUrlAllowed, fetchPage, type LookupFn,
} from "../../src/study/src/courseWebsite/fetcher.js";
import { parsePage, extractDue } from "../../src/study/src/courseWebsite/parsers.js";
import { zonedWallTimeToUtcIso } from "../../src/study/src/courseWebsite/timezone.js";
import {
  contentHash, shouldInsertSnapshot, buildCanonicalItems, flagCrossSourceConflicts,
  isContentOutcome, sourceRefFor,
} from "../../src/study/src/courseWebsite/store.js";
import { SE212_FALL_2026, CS241_FALL_2026, FALL_2026 } from "../../src/study/src/courseWebsite/sources.js";
import { CourseWebsiteTools } from "../../src/study/src/courseWebsite/tools.js";

const publicLookup: LookupFn = async () => [{ address: "142.150.1.1" }];       // UW public range
const privateLookup: LookupFn = async () => [{ address: "10.0.0.5" }];          // SSRF target

function htmlResponse(body: string, headers: Record<string, string> = {}) {
  const h = new Map(Object.entries({ "content-type": "text/html", ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return { status: 200, ok: true, headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null }, body: null, text: async () => body };
}
function statusResponse(status: number, location?: string) {
  const h = new Map<string, string>();
  if (location) h.set("location", location);
  return { status, ok: status >= 200 && status < 300, headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null }, body: null, text: async () => "" };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetDb(); });

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const SE212_ASN_HTML = `
<html><body>
<h1>SE 212 Assignments</h1>
<table>
  <tr><th>Assignment</th><th>Due</th><th>Handout</th></tr>
  <tr><td>Assignment 1: Propositional Logic</td><td>Due Friday, September 25, 2026 at 5:00 PM</td><td><a href="a1.pdf">A1 handout</a></td></tr>
  <tr><td>Assignment 2: Predicate Logic</td><td>Due Friday, October 9, 2026 at 5:00 PM</td><td><a href="a2.pdf">A2 handout</a></td></tr>
</table>
<p>Submit on <a href="https://markus.uwaterloo.ca/se212">MarkUs</a>.</p>
</body></html>`;

const SE212_SCHEDULE_HTML = `
<html><body>
<h1>SE 212 Schedule</h1>
<table>
  <tr><th>Date</th><th>Topic</th></tr>
  <tr><td>September 8, 2026</td><td>Lecture: Introduction to Logic</td></tr>
  <tr><td>September 10, 2026</td><td>Tutorial: Jape basics</td></tr>
</table>
</body></html>`;

// CS241 A1..A8 with exact due times.
const CS241_ASN_HTML = `
<html><body>
<h1>CS 241 Assignments</h1>
<ul>
  <li>A1 — Due Wednesday, September 16, 2026 at 5:00 pm</li>
  <li>A2 — Due Wednesday, September 23, 2026 at 5:00 pm</li>
  <li>A3 — Due Wednesday, September 30, 2026 at 5:00 pm</li>
  <li>A4 — Due Wednesday, October 7, 2026 at 5:00 pm</li>
  <li>A5 — Due Wednesday, October 21, 2026 at 5:00 pm</li>
  <li>A6 — Due Wednesday, October 28, 2026 at 5:00 pm</li>
  <li>A7 — Due Wednesday, November 4, 2026 at 5:00 pm</li>
  <li>A8 — Due Wednesday, November 18, 2026 at 11:59 pm</li>
</ul>
</body></html>`;

// ─── SE212 parsing ──────────────────────────────────────────────────────────────

describe("SE212 parsing", () => {
  it("parses assignments with due dates and handout links, records MarkUs as a reference", () => {
    const r = parsePage(SE212_ASN_HTML, "https://student.cs.uwaterloo.ca/~se212/asn.html", "assignments", "se212-assignments", SE212_FALL_2026);
    const names = r.items.map((i) => i.title);
    expect(names.some((n) => /Assignment 1/i.test(n))).toBe(true);
    expect(names.some((n) => /Assignment 2/i.test(n))).toBe(true);
    const a1 = r.items.find((i) => /Assignment 1/i.test(i.title))!;
    expect(a1.itemType).toBe("assignment");
    // 5:00 PM EDT on 2026-09-25 = 21:00 UTC.
    expect(a1.dueAtIso).toBe("2026-09-25T21:00:00.000Z");
    expect(a1.dueText).toMatch(/September 25, 2026 at 5:00 PM/);
    // MarkUs link recorded as a reference (blind spot), not fetched.
    expect(r.references.some((ref) => ref.kind === "markus")).toBe(true);
    // a1.pdf recorded as reference.
    expect(r.references.some((ref) => ref.kind === "pdf")).toBe(true);
  });

  it("parses the schedule as lecture/tutorial items (never assignments)", () => {
    const r = parsePage(SE212_SCHEDULE_HTML, "https://student.cs.uwaterloo.ca/~se212/schedule.html", "schedule", "se212-schedule", SE212_FALL_2026);
    const types = r.items.map((i) => i.itemType);
    expect(types).toContain("lecture");
    expect(types).toContain("tutorial");
    expect(types).not.toContain("assignment");
  });
});

// ─── CS241 A1–A8 ─────────────────────────────────────────────────────────────

describe("CS241 A1–A8 parsing with exact due times", () => {
  it("extracts all eight assignments with exact due instants", () => {
    const r = parsePage(CS241_ASN_HTML, "https://student.cs.uwaterloo.ca/~cs241/a/", "assignments", "cs241-assignments", CS241_FALL_2026);
    const assignments = r.items.filter((i) => i.itemType === "assignment");
    expect(assignments).toHaveLength(8);
    const byTitle = Object.fromEntries(assignments.map((a) => [a.title.match(/A\d/)?.[0], a.dueAtIso]));
    expect(byTitle.A1).toBe("2026-09-16T21:00:00.000Z"); // 5pm EDT
    expect(byTitle.A8).toBe("2026-11-19T04:59:00.000Z"); // 11:59pm EST (Nov 18) → next-day UTC
    // Every assignment has an exact time.
    expect(assignments.every((a) => a.dueAtIso !== null)).toBe(true);
  });
});

// ─── Timezone + original date preservation ───────────────────────────────────

describe("timezone conversion + original date text", () => {
  it("converts America/Toronto wall time to correct UTC across DST", () => {
    // EDT (summer, UTC-4)
    expect(zonedWallTimeToUtcIso({ year: 2026, month: 10, day: 3, hour: 17, minute: 0 }, "America/Toronto")).toBe("2026-10-03T21:00:00.000Z");
    // EST (winter, UTC-5)
    expect(zonedWallTimeToUtcIso({ year: 2026, month: 12, day: 1, hour: 17, minute: 0 }, "America/Toronto")).toBe("2026-12-01T22:00:00.000Z");
  });
  it("preserves the original date text verbatim and leaves undated items null", () => {
    const withTime = extractDue("Due Oct 3, 2026 at 5:00 PM", 2026, "America/Toronto");
    expect(withTime.dueText).toBe("Due Oct 3, 2026 at 5:00 PM");
    expect(withTime.dueAtIso).toBe("2026-10-03T21:00:00.000Z");
    const dateOnly = extractDue("Posted October 3", 2026, "America/Toronto");
    expect(dateOnly.dueText).toBe("Posted October 3");
    expect(dateOnly.dueAtIso).toBeNull(); // never invent a time
    const noDate = extractDue("See the notes page", 2026, "America/Toronto");
    expect(noDate.dueText).toBeNull();
  });
});

// ─── Snapshot dedup / change detection ───────────────────────────────────────

describe("snapshot dedup + change detection", () => {
  it("dedupes an unchanged content fetch and creates a new snapshot on change", () => {
    const h1 = contentHash("<p>Hello   world</p>");
    const h1b = contentHash("<p>Hello world</p>"); // whitespace-normalized → same
    expect(h1).toBe(h1b);
    expect(shouldInsertSnapshot(h1, h1b, "success")).toBe(false); // dedup
    const h2 = contentHash("<p>Hello world CHANGED</p>");
    expect(shouldInsertSnapshot(h1, h2, "success")).toBe(true);  // changed → new snapshot
  });
  it("always records non-content outcomes as history (never deduped away)", () => {
    expect(shouldInsertSnapshot("abc", null, "empty")).toBe(true);
    expect(shouldInsertSnapshot("abc", null, "http_error")).toBe(true);
    expect(shouldInsertSnapshot("abc", null, "auth_required")).toBe(true);
    expect(isContentOutcome("success")).toBe(true);
    expect(isContentOutcome("empty")).toBe(false);
  });
});

// ─── Cross-source conflict flagging ──────────────────────────────────────────

describe("conflicting dates across website and D2L", () => {
  it("flags a due-date disagreement instead of silently choosing one", () => {
    const items = buildCanonicalItems("u1", SE212_FALL_2026, "assignments", "https://student.cs.uwaterloo.ca/~se212/asn.html", [
      { itemType: "assignment", title: "Assignment 1", dueText: "Sep 25 5pm", dueAtIso: "2026-09-25T21:00:00.000Z", points: null, url: null, statusNote: null },
    ]);
    const other = new Map([["assignment 1", { dueIso: "2026-09-26T21:00:00.000Z", source: "learn" }]]);
    const flagged = flagCrossSourceConflicts(items, other, "2026-09-01T00:00:00.000Z");
    expect(flagged[0].conflicts).toHaveLength(1);
    expect(flagged[0].conflicts[0].kind).toBe("cross-source");
    expect(flagged[0].conflicts[0].otherSource).toBe("learn");
    // Website value is NOT discarded; both are retained.
    expect(flagged[0].dueAt).toBe("2026-09-25T21:00:00.000Z");
    expect(flagged[0].conflicts[0].previous).toBe("2026-09-26T21:00:00.000Z");
  });
});

// ─── Malformed HTML / layout changes ─────────────────────────────────────────

describe("malformed HTML + layout changes", () => {
  it("does not throw and still extracts what it can from broken markup", () => {
    const broken = `<html><body><h1>CS 241 <ul><li>A1 Due September 16, 2026 at 5:00 pm<li>A2 no closing tags`;
    const r = parsePage(broken, "https://student.cs.uwaterloo.ca/~cs241/a/", "assignments", "cs241-assignments", CS241_FALL_2026);
    expect(r.items.some((i) => i.dueAtIso === "2026-09-16T21:00:00.000Z")).toBe(true);
  });
  it("adapts when assignments are laid out as list items instead of a table", () => {
    const listLayout = `<html><body><ul><li>Assignment 1 due Sept 25, 2026 at 5:00 PM</li></ul></body></html>`;
    const r = parsePage(listLayout, "https://student.cs.uwaterloo.ca/~se212/asn.html", "assignments", "se212-assignments", SE212_FALL_2026);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].dueAtIso).toBe("2026-09-25T21:00:00.000Z");
  });
});

// ─── SSRF + redirect protection ──────────────────────────────────────────────

describe("SSRF + redirect protection", () => {
  it("classifies private/reserved IPs as unsafe", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("169.254.1.1")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("172.16.5.4")).toBe(true);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fd00::1")).toBe(true);
    expect(isPrivateIp("142.150.1.1")).toBe(false); // public
  });
  it("rejects non-https, wrong-origin, and non-allowlisted URLs", () => {
    const origins = ["https://student.cs.uwaterloo.ca"];
    const patterns = [/^https:\/\/student\.cs\.uwaterloo\.ca\/~se212\/[a-z.]+$/i];
    expect(() => assertUrlAllowed("http://student.cs.uwaterloo.ca/~se212/", origins, patterns, false)).toThrow(/scheme/);
    expect(() => assertUrlAllowed("https://evil.com/~se212/", origins, patterns, false)).toThrow(/origin/);
    expect(() => assertUrlAllowed("https://student.cs.uwaterloo.ca/~cs999/x", origins, patterns, true)).toThrow(/allowlist/);
  });
  it("blocks a fetch whose host resolves to a private IP (SSRF)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse("<p>should never be read</p>")));
    const res = await fetchPage("https://student.cs.uwaterloo.ca/~se212/", {
      allowedOrigins: SE212_FALL_2026.allowedOrigins,
      allowPatterns: SE212_FALL_2026.linkDiscovery.allowPatterns,
      lookupFn: privateLookup, maxRetries: 0,
    });
    expect(res.outcome).toBe("blocked");
  });
  it("blocks a redirect that leaves the allowlist", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(statusResponse(302, "https://evil.example.com/steal"));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await fetchPage("https://student.cs.uwaterloo.ca/~se212/", {
      allowedOrigins: SE212_FALL_2026.allowedOrigins,
      allowPatterns: SE212_FALL_2026.linkDiscovery.allowPatterns,
      lookupFn: publicLookup, maxRetries: 0,
    });
    expect(res.outcome).toBe("blocked");
  });
  it("reports auth honestly on a login redirect (never bypasses)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statusResponse(302, "https://auth.uwaterloo.ca/oidc/login")));
    const res = await fetchPage("https://student.cs.uwaterloo.ca/~cs241/", {
      allowedOrigins: CS241_FALL_2026.allowedOrigins,
      allowPatterns: CS241_FALL_2026.linkDiscovery.allowPatterns,
      lookupFn: publicLookup, maxRetries: 0,
    });
    expect(res.outcome).toBe("auth_required");
  });
  it("maps HTTP 404 / 403 to http_error / auth_required", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statusResponse(404)));
    const r404 = await fetchPage("https://student.cs.uwaterloo.ca/~se212/", { allowedOrigins: SE212_FALL_2026.allowedOrigins, allowPatterns: SE212_FALL_2026.linkDiscovery.allowPatterns, lookupFn: publicLookup, maxRetries: 0 });
    expect(r404.outcome).toBe("http_error");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statusResponse(403)));
    const r403 = await fetchPage("https://student.cs.uwaterloo.ca/~se212/", { allowedOrigins: SE212_FALL_2026.allowedOrigins, allowPatterns: SE212_FALL_2026.linkDiscovery.allowPatterns, lookupFn: publicLookup, maxRetries: 0 });
    expect(r403.outcome).toBe("auth_required");
  });
});

// ─── Tool behavior: preservation, no-Notion, isolation ───────────────────────

const CW_FETCH_OPTS_NOTE = "tool tests drive the real handler with stubbed fetch + mocked supabase";

describe(`refresh_course_websites — ${CW_FETCH_OPTS_NOTE}`, () => {
  beforeEach(() => { resetDb(); });

  function stubFetchReturning(map: Record<string, ReturnType<typeof htmlResponse> | ReturnType<typeof statusResponse>>) {
    const spy = vi.fn(async (url: string) => {
      // exact match first, else any approved SE212 page returns the same fixture
      const key = Object.keys(map).find((k) => url.startsWith(k));
      return key ? map[key] : statusResponse(404);
    });
    vi.stubGlobal("fetch", spy);
    return spy;
  }
  // Patch the DNS resolver used by the connector by monkey-patching fetchPage opts:
  // the tool uses the default resolver, so we stub global fetch AND rely on the
  // resolver being bypassed for IP hosts. To keep it deterministic we stub fetch to
  // resolve immediately; DNS still runs, so we point tests at the real public host.

  it("ingests canonical items + tasks on a successful SE212 assignments fetch", async () => {
    // Only the assignments page returns content; others 404 (still preserved).
    stubFetchReturning({ "https://student.cs.uwaterloo.ca/~se212/asn.html": htmlResponse(SE212_ASN_HTML) });
    // Point the source's DNS through a public resolver by overriding fetchPage? The
    // tool calls fetchPage with default lookup; to avoid real DNS we assert on the
    // recorded DB writes that happen only for the content page.
    const out = JSON.parse(await CourseWebsiteTools.refresh_course_websites.handler({ courseCode: "SE212", userId: "u1" }));
    expect(out.success).toBe(true);
    // Item + task upserts happened for the assignments page.
    const itemUpserts = db.recorded.filter((r) => r.table === "course_website_items" && r.op === "upsert");
    const taskUpserts = db.recorded.filter((r) => r.table === "tasks" && r.op === "upsert");
    expect(itemUpserts.length).toBeGreaterThan(0);
    expect(taskUpserts.length).toBeGreaterThan(0);
    // NEVER touches Notion or triggers background sync.
    const fetchCalls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(fetchCalls.some((u: string) => u.includes("api.notion.com"))).toBe(false);
  });

  it("preserves existing records on empty/failed fetches (no item or task writes)", async () => {
    // All pages 404 → non-content outcomes → snapshots recorded, but NO item/task writes.
    stubFetchReturning({});
    const out = JSON.parse(await CourseWebsiteTools.refresh_course_websites.handler({ courseCode: "SE212", userId: "u1" }));
    expect(out.success).toBe(true);
    const itemUpserts = db.recorded.filter((r) => r.table === "course_website_items" && r.op === "upsert");
    const taskUpserts = db.recorded.filter((r) => r.table === "tasks" && r.op === "upsert");
    expect(itemUpserts).toHaveLength(0);
    expect(taskUpserts).toHaveLength(0);
    // Snapshots WERE recorded (history of the failure).
    const snapInserts = db.recorded.filter((r) => r.table === "course_website_snapshots" && r.op === "insert");
    expect(snapInserts.length).toBeGreaterThan(0);
  });
});

describe("get_course_website_content — read-only + cross-user/course isolation", () => {
  it("scopes reads to the requesting user and course", async () => {
    resetDb();
    vi.stubGlobal("fetch", vi.fn()); // must never be called by a read-only tool
    await CourseWebsiteTools.get_course_website_content.handler({ courseCode: "CS241", term: FALL_2026, userId: "userA" });
    const itemReads = db.recorded.filter((r) => r.table === "course_website_items" && r.op === "select");
    expect(itemReads.length).toBeGreaterThan(0);
    // Every read filtered by the requesting user AND the requested course.
    expect(itemReads.every((r) => r.filters.user_id === "userA")).toBe(true);
    expect(itemReads.every((r) => r.filters.course_code === "CS241")).toBe(true);
    // No network for a read-only tool.
    expect((globalThis.fetch as any).mock.calls.length).toBe(0);
  });
});

// ─── Secret / cookie redaction ───────────────────────────────────────────────

describe("secret + cookie redaction", () => {
  it("source_ref is stable and slugged (no PII); sanitizer strips sensitive tokens", async () => {
    expect(sourceRefFor(SE212_FALL_2026, "assignments", "Assignment 1: Logic")).toBe("SE212|1269|assignments|assignment-1-logic");
    // The store never persists cookies/authorization; verify the sanitizer via a snapshot insert.
    resetDb();
    const mod = await import("../../src/study/src/courseWebsite/store.js");
    await mod.recordSnapshot({
      userId: "u1", source: SE212_FALL_2026, pageType: "home",
      fetch: { requestedUrl: "x", finalUrl: "https://student.cs.uwaterloo.ca/~se212/", outcome: "success", httpStatus: 200, contentType: "text/html", sourceUpdatedAt: null, body: "Set-Cookie: secret=abc; Authorization: Bearer tok123", error: null },
      extracted: null, parseError: null,
    });
    const snap = db.recorded.find((r) => r.table === "course_website_snapshots" && r.op === "insert");
    expect(snap!.row.payload).not.toMatch(/secret=abc/);
    expect(snap!.row.payload).toContain("[redacted]");
  });
});
