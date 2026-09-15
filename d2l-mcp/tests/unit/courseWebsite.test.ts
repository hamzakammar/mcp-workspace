/**
 * Course-website ingestion connector — unit tests.
 *
 * Deterministic: inline HTML fixtures + stubbed global fetch + injected DNS
 * resolver + a scope-aware, failure-injectable Supabase fake (including the atomic
 * ingest RPC). No live network is required for the normal suite.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "142.150.1.1", family: 4 }] }));

interface FakeSnap { id: string; user_id: string; course_code: string; term: string; url: string; content_hash: string | null; parser_version: string; parse_status: string }
const db = {
  existingItem: null as any,
  otherTasks: [] as Array<{ title: string; due_at: string | null; source: string }>,
  canonicalItems: [] as unknown[],
  snapshots: [] as FakeSnap[],
  recorded: [] as Array<{ table?: string; op: string; row?: any; filters?: Record<string, unknown> }>,
  rpcCalls: [] as Array<{ name: string; payload: any }>,
  // Force a stage to fail. rpcFail simulates the atomic ingest rolling back.
  failOn: {} as { snapshotInsert?: boolean; snapshotLatest?: boolean; itemsRead?: boolean; snapshotsRead?: boolean },
  rpcFail: null as null | { stage: "snapshot" | "canonical_item" | "task"; sourceRef?: string },
  seq: 0,
};
function resetDb() {
  db.existingItem = null; db.otherTasks = []; db.canonicalItems = [];
  db.snapshots = []; db.recorded = []; db.rpcCalls = []; db.failOn = {}; db.rpcFail = null; db.seq = 0;
}
const dbErr = (message: string) => ({ data: null, error: { message } });

vi.mock("../../src/utils/supabase.js", () => {
  function makeQuery(table: string) {
    const state = { table, op: "select", row: undefined as any, filters: {} as Record<string, unknown> };
    const resolve = async () => {
      db.recorded.push({ table, op: state.op, row: state.row, filters: { ...state.filters } });
      if (state.op === "insert") { // recordSnapshotOnly path (snapshots)
        if (db.failOn.snapshotInsert) return dbErr("snapshot insert boom");
        const id = `snap-${++db.seq}`;
        db.snapshots.push({ id, user_id: state.row.user_id, course_code: state.row.course_code, term: state.row.term, url: state.row.url, content_hash: state.row.content_hash ?? null, parser_version: state.row.parser_version, parse_status: state.row.parse_status });
        return { data: { id }, error: null };
      }
      if (table === "course_website_snapshots") {
        // Scoped dedup lookup / snapshot read (newest-first).
        if (db.failOn.snapshotLatest) return dbErr("snapshot lookup boom");
        if (db.failOn.snapshotsRead) return dbErr("snapshots read boom");
        const f = state.filters;
        const matches = db.snapshots.filter((s) =>
          (f.user_id === undefined || s.user_id === f.user_id) &&
          (f.course_code === undefined || s.course_code === f.course_code) &&
          (f.term === undefined || s.term === f.term) &&
          (f.url === undefined || s.url === f.url));
        return { data: [...matches].reverse(), error: null }; // newest first
      }
      if (table === "course_website_items") {
        if (state.filters.source_ref !== undefined) return { data: db.existingItem, error: null };
        if (db.failOn.itemsRead) return dbErr("items read boom");
        return { data: db.canonicalItems, error: null };
      }
      if (table === "tasks") return { data: db.otherTasks, error: null };
      return { data: null, error: null };
    };
    const q: any = {};
    q.select = () => q; q.eq = (k: string, v: unknown) => { state.filters[k] = v; return q; };
    q.neq = () => q; q.order = () => q; q.limit = () => q;
    q.insert = (row: any) => { state.op = "insert"; state.row = row; return q; };
    q.upsert = (row: any) => { state.op = "upsert"; state.row = row; return q; };
    q.maybeSingle = () => resolve();
    q.then = (res: any, rej: any) => resolve().then(res, rej);
    return q;
  }
  async function rpc(name: string, params: any) {
    db.rpcCalls.push({ name, payload: params?.p_payload });
    if (name === "ingest_course_website_page") {
      if (db.rpcFail) {
        // Atomic function raised → whole page transaction rolls back (nothing committed).
        return dbErr(`stage=${db.rpcFail.stage} source_ref=${db.rpcFail.sourceRef ?? ""} boom`);
      }
      const p = params.p_payload;
      const dedup = p.dedup_snapshot_id;
      let snapshotId = dedup;
      let inserted = 0;
      if (!dedup) {
        const id = `snap-${++db.seq}`;
        db.snapshots.push({ id, user_id: p.user_id, course_code: p.course_code, term: p.term, url: p.url, content_hash: p.content_hash ?? null, parser_version: p.parser_version, parse_status: p.parse_status });
        snapshotId = id; inserted = 1;
      }
      return { data: { snapshot_id: snapshotId, deduped: !!dedup, snapshots_inserted: inserted, items_upserted: (p.items || []).length, tasks_upserted: (p.tasks || []).length }, error: null };
    }
    return { data: null, error: null };
  }
  return { supabase: { from: (t: string) => makeQuery(t), rpc } };
});

import { isPrivateIp, assertUrlAllowed, fetchPage, type LookupFn } from "../../src/study/src/courseWebsite/fetcher.js";
import { parsePage, extractDue } from "../../src/study/src/courseWebsite/parsers.js";
import { zonedWallTimeToUtcIso } from "../../src/study/src/courseWebsite/timezone.js";
import {
  contentHash, buildCanonicalItems, flagCrossSourceConflicts, sourceRefFor,
  pickDedupSnapshotId, ingestPage, recordSnapshotOnly, buildTaskRows,
} from "../../src/study/src/courseWebsite/store.js";
import { SE212_FALL_2026, CS241_FALL_2026, FALL_2026 } from "../../src/study/src/courseWebsite/sources.js";
import { CourseWebsiteTools } from "../../src/study/src/courseWebsite/tools.js";

const publicLookup: LookupFn = async () => [{ address: "142.150.1.1" }];
const privateLookup: LookupFn = async () => [{ address: "10.0.0.5" }];

function htmlResponse(body: string, headers: Record<string, string> = {}) {
  const h = new Map(Object.entries({ "content-type": "text/html", ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return { status: 200, ok: true, headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null }, body: null, text: async () => body };
}
function statusResponse(status: number, location?: string) {
  const h = new Map<string, string>();
  if (location) h.set("location", location);
  return { status, ok: status >= 200 && status < 300, headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null }, body: null, text: async () => "" };
}
function mkFetch(url: string, body: string | null, outcome = "success", httpStatus: number | null = 200) {
  return { requestedUrl: url, finalUrl: url, outcome, httpStatus, contentType: "text/html", sourceUpdatedAt: null, body, error: null } as any;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetDb(); });

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const SE212_HOME_HTML = `<html><body><h1>SE212</h1><a href="schedule.html">Schedule</a><a href="asn.html">Assignments</a><a href="notes.html">Lectures</a></body></html>`;
const SE212_NOTES_HTML = `<html><body><h1>Lectures</h1><a href="notes/m1.pdf">Module 1 notes</a></body></html>`;
const SE212_ASN_HTML = `
<html><body><h1>SE 212 Assignments</h1>
<table>
  <tr><th>Assignment</th><th>Due</th><th>Handout</th></tr>
  <tr><td>Assignment 1: Propositional Logic</td><td>Due Friday, September 25, 2026 at 5:00 PM</td><td><a href="a1.pdf">A1 handout</a></td></tr>
  <tr><td>Assignment 2: Predicate Logic</td><td>Due Friday, October 9, 2026 at 5:00 PM</td><td><a href="a2.pdf">A2 handout</a></td></tr>
</table>
<p>Submit on <a href="https://markus.uwaterloo.ca/se212">MarkUs</a>.</p></body></html>`;
const SE212_SCHEDULE_HTML = `
<html><body><h1>SE 212 Schedule</h1>
<table>
  <tr><th>Date</th><th>Topic</th></tr>
  <tr><td>September 8, 2026</td><td>Lecture: Introduction to Logic</td></tr>
  <tr><td>September 10, 2026</td><td>Tutorial: Jape basics</td></tr>
</table></body></html>`;
const CS241_ASN_HTML = `
<html><body><h1>CS 241 Assignments</h1><ul>
  <li>A1 — Due Wednesday, September 16, 2026 at 5:00 pm</li>
  <li>A2 — Due Wednesday, September 23, 2026 at 5:00 pm</li>
  <li>A3 — Due Wednesday, September 30, 2026 at 5:00 pm</li>
  <li>A4 — Due Wednesday, October 7, 2026 at 5:00 pm</li>
  <li>A5 — Due Wednesday, October 21, 2026 at 5:00 pm</li>
  <li>A6 — Due Wednesday, October 28, 2026 at 5:00 pm</li>
  <li>A7 — Due Wednesday, November 4, 2026 at 5:00 pm</li>
  <li>A8 — Due Wednesday, November 18, 2026 at 11:59 pm</li>
</ul></body></html>`;

// A full-content stub for every SE212 approved page (fully-successful run).
function stubSE212AllOk() {
  const map: Record<string, string> = {
    "https://student.cs.uwaterloo.ca/~se212/": SE212_HOME_HTML,
    "https://student.cs.uwaterloo.ca/~se212/schedule.html": SE212_SCHEDULE_HTML,
    "https://student.cs.uwaterloo.ca/~se212/asn.html": SE212_ASN_HTML,
    "https://student.cs.uwaterloo.ca/~se212/notes.html": SE212_NOTES_HTML,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const key = Object.keys(map).find((k) => url === k);
    return key ? htmlResponse(map[key]) : statusResponse(404);
  }));
}
// Only the assignments page returns content; the other approved pages 404.
function stubSE212AsnOnly() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    url.startsWith("https://student.cs.uwaterloo.ca/~se212/asn.html") ? htmlResponse(SE212_ASN_HTML) : statusResponse(404)));
}

// ─── SE212 / CS241 parsing (pure) ────────────────────────────────────────────

describe("SE212 parsing", () => {
  it("parses assignments with due dates + handout links; records MarkUs as a reference", () => {
    const r = parsePage(SE212_ASN_HTML, "https://student.cs.uwaterloo.ca/~se212/asn.html", "assignments", "se212-assignments", SE212_FALL_2026);
    const a1 = r.items.find((i) => /Assignment 1/i.test(i.title))!;
    expect(a1.dueAtIso).toBe("2026-09-25T21:00:00.000Z");
    expect(a1.dueText).toMatch(/September 25, 2026 at 5:00 PM/);
    expect(r.references.some((ref) => ref.kind === "markus")).toBe(true);
    expect(r.references.some((ref) => ref.kind === "pdf")).toBe(true);
  });
  it("parses schedule as lecture/tutorial (never assignments)", () => {
    const r = parsePage(SE212_SCHEDULE_HTML, "https://student.cs.uwaterloo.ca/~se212/schedule.html", "schedule", "se212-schedule", SE212_FALL_2026);
    const types = r.items.map((i) => i.itemType);
    expect(types).toContain("lecture"); expect(types).toContain("tutorial"); expect(types).not.toContain("assignment");
  });
});

describe("CS241 A1–A8 parsing with exact due times", () => {
  it("extracts all eight assignments with exact due instants", () => {
    const r = parsePage(CS241_ASN_HTML, "https://student.cs.uwaterloo.ca/~cs241/a/", "assignments", "cs241-assignments", CS241_FALL_2026);
    const a = r.items.filter((i) => i.itemType === "assignment");
    expect(a).toHaveLength(8);
    const byT = Object.fromEntries(a.map((x) => [x.title.match(/A\d/)?.[0], x.dueAtIso]));
    expect(byT.A1).toBe("2026-09-16T21:00:00.000Z");
    expect(byT.A8).toBe("2026-11-19T04:59:00.000Z");
    expect(a.every((x) => x.dueAtIso !== null)).toBe(true);
  });
});

describe("timezone conversion + original date text", () => {
  it("converts America/Toronto wall time to UTC across DST", () => {
    expect(zonedWallTimeToUtcIso({ year: 2026, month: 10, day: 3, hour: 17, minute: 0 }, "America/Toronto")).toBe("2026-10-03T21:00:00.000Z");
    expect(zonedWallTimeToUtcIso({ year: 2026, month: 12, day: 1, hour: 17, minute: 0 }, "America/Toronto")).toBe("2026-12-01T22:00:00.000Z");
  });
  it("preserves original date text and leaves undated items null", () => {
    expect(extractDue("Due Oct 3, 2026 at 5:00 PM", 2026, "America/Toronto")).toEqual({ dueText: "Due Oct 3, 2026 at 5:00 PM", dueAtIso: "2026-10-03T21:00:00.000Z" });
    expect(extractDue("Posted October 3", 2026, "America/Toronto")).toEqual({ dueText: "Posted October 3", dueAtIso: null });
    expect(extractDue("See notes", 2026, "America/Toronto")).toEqual({ dueText: null, dueAtIso: null });
  });
});

describe("malformed HTML + layout changes", () => {
  it("does not throw on broken markup", () => {
    const broken = `<html><body><h1>CS 241 <ul><li>A1 Due September 16, 2026 at 5:00 pm<li>A2 no close`;
    const r = parsePage(broken, "https://student.cs.uwaterloo.ca/~cs241/a/", "assignments", "cs241-assignments", CS241_FALL_2026);
    expect(r.items.some((i) => i.dueAtIso === "2026-09-16T21:00:00.000Z")).toBe(true);
  });
  it("adapts to list layout instead of table", () => {
    const r = parsePage(`<html><body><ul><li>Assignment 1 due Sept 25, 2026 at 5:00 PM</li></ul></body></html>`, "https://student.cs.uwaterloo.ca/~se212/asn.html", "assignments", "se212-assignments", SE212_FALL_2026);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].dueAtIso).toBe("2026-09-25T21:00:00.000Z");
  });
});

// ─── SSRF + redirect protection ──────────────────────────────────────────────

describe("SSRF + redirect protection", () => {
  it("classifies private/reserved IPs as unsafe", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.1.1", "192.168.1.1", "172.16.5.4", "::1", "fd00::1"]) expect(isPrivateIp(ip)).toBe(true);
    expect(isPrivateIp("142.150.1.1")).toBe(false);
  });
  it("rejects non-https, wrong-origin, non-allowlisted URLs", () => {
    const o = ["https://student.cs.uwaterloo.ca"]; const p = [/^https:\/\/student\.cs\.uwaterloo\.ca\/~se212\/[a-z.]+$/i];
    expect(() => assertUrlAllowed("http://student.cs.uwaterloo.ca/~se212/", o, p, false)).toThrow(/scheme/);
    expect(() => assertUrlAllowed("https://evil.com/~se212/", o, p, false)).toThrow(/origin/);
    expect(() => assertUrlAllowed("https://student.cs.uwaterloo.ca/~cs999/x", o, p, true)).toThrow(/allowlist/);
  });
  it("blocks a fetch resolving to a private IP", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse("x")));
    const r = await fetchPage("https://student.cs.uwaterloo.ca/~se212/", { allowedOrigins: SE212_FALL_2026.allowedOrigins, allowPatterns: SE212_FALL_2026.linkDiscovery.allowPatterns, lookupFn: privateLookup, maxRetries: 0 });
    expect(r.outcome).toBe("blocked");
  });
  it("blocks a redirect leaving the allowlist; reports auth on login redirect", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statusResponse(302, "https://evil.example.com/x")));
    expect((await fetchPage("https://student.cs.uwaterloo.ca/~se212/", { allowedOrigins: SE212_FALL_2026.allowedOrigins, allowPatterns: SE212_FALL_2026.linkDiscovery.allowPatterns, lookupFn: publicLookup, maxRetries: 0 })).outcome).toBe("blocked");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statusResponse(302, "https://auth.uwaterloo.ca/oidc/login")));
    expect((await fetchPage("https://student.cs.uwaterloo.ca/~cs241/", { allowedOrigins: CS241_FALL_2026.allowedOrigins, allowPatterns: CS241_FALL_2026.linkDiscovery.allowPatterns, lookupFn: publicLookup, maxRetries: 0 })).outcome).toBe("auth_required");
  });
  it("maps 404→http_error, 403→auth_required", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statusResponse(404)));
    expect((await fetchPage("https://student.cs.uwaterloo.ca/~se212/", { allowedOrigins: SE212_FALL_2026.allowedOrigins, allowPatterns: SE212_FALL_2026.linkDiscovery.allowPatterns, lookupFn: publicLookup, maxRetries: 0 })).outcome).toBe("http_error");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(statusResponse(403)));
    expect((await fetchPage("https://student.cs.uwaterloo.ca/~se212/", { allowedOrigins: SE212_FALL_2026.allowedOrigins, allowPatterns: SE212_FALL_2026.linkDiscovery.allowPatterns, lookupFn: publicLookup, maxRetries: 0 })).outcome).toBe("auth_required");
  });
});

// ─── Cross-source conflict flagging (pure) ───────────────────────────────────

describe("conflicting dates across website and D2L", () => {
  it("flags a due-date disagreement without choosing a winner", () => {
    const items = buildCanonicalItems("u1", SE212_FALL_2026, "assignments", "https://student.cs.uwaterloo.ca/~se212/asn.html", [
      { itemType: "assignment", title: "Assignment 1", dueText: "Sep 25 5pm", dueAtIso: "2026-09-25T21:00:00.000Z", points: null, url: null, statusNote: null },
    ]);
    const flagged = flagCrossSourceConflicts(items, new Map([["assignment 1", { dueIso: "2026-09-26T21:00:00.000Z", source: "learn" }]]), "2026-09-01T00:00:00.000Z");
    expect(flagged[0].conflicts[0].kind).toBe("cross-source");
    expect(flagged[0].dueAt).toBe("2026-09-25T21:00:00.000Z");
    expect(flagged[0].conflicts[0].previous).toBe("2026-09-26T21:00:00.000Z");
  });
});

// ─── Dedup semantics (parse_status + parser_version aware) ───────────────────

describe("pickDedupSnapshotId — dedup requires content_hash + parser_version + parse_status=ok", () => {
  const V = "cw-parser@1";
  it("a failed parse is NEVER reused by a later successful parse of identical content", () => {
    const existing = [{ id: "failed-1", content_hash: "H", parser_version: V, parse_status: "failed" }];
    expect(pickDedupSnapshotId(existing, "H", V)).toBeNull(); // must create a fresh ok snapshot
  });
  it("a parser-version change is never deduped (re-parse of record)", () => {
    const existing = [{ id: "ok-v1", content_hash: "H", parser_version: "v1", parse_status: "ok" }];
    expect(pickDedupSnapshotId(existing, "H", "v2")).toBeNull();
  });
  it("repeated successful parse of identical content + same version dedups", () => {
    const existing = [{ id: "ok-1", content_hash: "H", parser_version: V, parse_status: "ok" }];
    expect(pickDedupSnapshotId(existing, "H", V)).toBe("ok-1");
  });
  it("picks the newest matching ok snapshot; never a null hash", () => {
    const existing = [{ id: "ok-new", content_hash: "H", parser_version: V, parse_status: "ok" }, { id: "ok-old", content_hash: "H", parser_version: V, parse_status: "ok" }];
    expect(pickDedupSnapshotId(existing, "H", V)).toBe("ok-new");
    expect(pickDedupSnapshotId(existing, null, V)).toBeNull();
  });
});

describe("ingestPage dedup is scoped and never reuses a failed snapshot as provenance", () => {
  beforeEach(() => resetDb());
  const URL = "https://student.cs.uwaterloo.ca/~x/p.html";
  const body = "<p>same</p>";

  it("does not dedup identical content across course/term/user; dedups only within the exact scope", async () => {
    const r1 = await ingestPage({ userId: "u1", source: CS241_FALL_2026, pageType: "assignments", fetch: mkFetch(URL, body), extracted: {}, items: [] });
    expect(r1.deduped).toBe(false);
    // different course, same url+content → independent
    const r2 = await ingestPage({ userId: "u1", source: SE212_FALL_2026, pageType: "assignments", fetch: mkFetch(URL, body), extracted: {}, items: [] });
    expect(r2.deduped).toBe(false);
    expect(r2.snapshotId).not.toBe(r1.snapshotId);
    // different term → independent
    const r3 = await ingestPage({ userId: "u1", source: { ...CS241_FALL_2026, term: "1259" }, pageType: "assignments", fetch: mkFetch(URL, body), extracted: {}, items: [] });
    expect(r3.deduped).toBe(false);
    // different user → independent
    const r4 = await ingestPage({ userId: "u2", source: CS241_FALL_2026, pageType: "assignments", fetch: mkFetch(URL, body), extracted: {}, items: [] });
    expect(r4.deduped).toBe(false);
    // same scope + identical content → dedups against its own prior ok snapshot
    const r5 = await ingestPage({ userId: "u1", source: CS241_FALL_2026, pageType: "assignments", fetch: mkFetch(URL, body), extracted: {}, items: [] });
    expect(r5.deduped).toBe(true);
    expect(r5.snapshotId).toBe(r1.snapshotId);
    // the dedup lookup was scoped by user_id + course_code + term + url
    const lookups = db.recorded.filter((r) => r.table === "course_website_snapshots" && r.op === "select");
    expect(lookups.every((r) => ["user_id", "course_code", "term", "url"].every((k) => k in (r.filters || {})))).toBe(true);
  });

  it("a prior FAILED parse of identical content does not become provenance; a fresh snapshot is inserted", async () => {
    // record a failed-parse snapshot of the content
    await recordSnapshotOnly({ userId: "u1", source: SE212_FALL_2026, pageType: "assignments", fetch: mkFetch(URL, body), parseStatus: "failed", parseError: "boom" });
    const r = await ingestPage({ userId: "u1", source: SE212_FALL_2026, pageType: "assignments", fetch: mkFetch(URL, body), extracted: {}, items: [] });
    expect(r.deduped).toBe(false);               // did NOT reuse the failed snapshot
    expect(r.snapshotId).not.toBe("snap-1");      // links items to a new ok snapshot
    // ingest was called with dedup_snapshot_id null
    const call = db.rpcCalls.find((c) => c.name === "ingest_course_website_page")!;
    expect(call.payload.dedup_snapshot_id).toBeNull();
  });
});

// ─── recordSnapshotOnly persists parse_status ────────────────────────────────

describe("recordSnapshotOnly persists parse_status independently of fetch_outcome", () => {
  beforeEach(() => resetDb());
  it("stores parse_status=failed for a fetch-success/parse-failure", async () => {
    await recordSnapshotOnly({ userId: "u1", source: SE212_FALL_2026, pageType: "assignments", fetch: mkFetch("u", "<p>x</p>"), parseStatus: "failed", parseError: "parser_error: boom" });
    const ins = db.recorded.find((r) => r.table === "course_website_snapshots" && r.op === "insert")!;
    expect(ins.row.fetch_outcome).toBe("success");
    expect(ins.row.parse_status).toBe("failed");
    expect(ins.row.error).toMatch(/parser_error/);
  });
  it("stores parse_status=skipped for a non-content outcome", async () => {
    await recordSnapshotOnly({ userId: "u1", source: SE212_FALL_2026, pageType: "home", fetch: mkFetch("u", null, "http_error", 404), parseStatus: "skipped", parseError: null });
    const ins = db.recorded.find((r) => r.table === "course_website_snapshots" && r.op === "insert")!;
    expect(ins.row.parse_status).toBe("skipped");
    expect(ins.row.content_hash).toBeNull();
  });
});

// ─── Atomic persistence + truthful results ───────────────────────────────────

describe("refresh_course_websites — atomic persistence + result semantics", () => {
  beforeEach(() => resetDb());

  it("fully successful run: success:true, partial:false, items+tasks committed via the atomic RPC", async () => {
    stubSE212AllOk();
    const out = JSON.parse(await CourseWebsiteTools.refresh_course_websites.handler({ courseCode: "SE212", userId: "u1" }));
    expect(out.success).toBe(true);
    expect(out.partial).toBe(false);
    expect(out.failures).toHaveLength(0);
    // The assignments page committed its items + tasks atomically.
    const asn = out.courses[0].pages.find((p: any) => p.pageType === "assignments");
    expect(asn.succeeded).toBe(true);
    expect(asn.itemsCommitted).toBeGreaterThan(0);
    expect(asn.tasksCommitted).toBeGreaterThan(0);
    // Persisted via the transactional RPC, never per-row .from().upsert().
    expect(db.rpcCalls.some((c) => c.name === "ingest_course_website_page")).toBe(true);
    expect(db.recorded.some((r) => r.table === "course_website_items" && r.op === "upsert")).toBe(false);
    // Never touches Notion.
    expect((globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0])).some((u: string) => u.includes("api.notion.com"))).toBe(false);
  });

  it("partial run: one approved page 404s while another ingests → success:false, partial:true", async () => {
    stubSE212AsnOnly(); // asn ok, home/schedule/notes 404
    const out = JSON.parse(await CourseWebsiteTools.refresh_course_websites.handler({ courseCode: "SE212", userId: "u1" }));
    expect(out.success).toBe(false);
    expect(out.partial).toBe(true);
    // structured failures include the 404 approved pages
    expect(out.failures.length).toBeGreaterThan(0);
    expect(out.failures[0]).toHaveProperty("course");
    expect(out.failures[0]).toHaveProperty("url");
    expect(out.failures[0]).toHaveProperty("stage");
    expect(out.failures[0]).toHaveProperty("outcome");
    // the asn page still ingested successfully
    expect(out.courses[0].pages.find((p: any) => p.pageType === "assignments").succeeded).toBe(true);
  });

  it("completely failed run: all approved pages 404 → success:false, partial:false, nothing ingested", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => statusResponse(404)));
    const out = JSON.parse(await CourseWebsiteTools.refresh_course_websites.handler({ courseCode: "SE212", userId: "u1" }));
    expect(out.success).toBe(false);
    expect(out.partial).toBe(false);
    expect(db.rpcCalls.some((c) => c.name === "ingest_course_website_page")).toBe(false);
    // Snapshots were still recorded honestly (history), but no items/tasks.
    expect(db.recorded.some((r) => r.table === "course_website_snapshots" && r.op === "insert")).toBe(true);
  });

  it.each([
    ["snapshot", "snapshot"],
    ["canonical_item", "canonical_item"],
    ["task", "task"],
  ])("atomic rollback on %s-stage failure: success:false, 0 committed, structured failure", async (stage) => {
    stubSE212AsnOnly();
    db.rpcFail = { stage: stage as any, sourceRef: "SE212|1269|assignments|assignment-1" };
    const out = JSON.parse(await CourseWebsiteTools.refresh_course_websites.handler({ courseCode: "SE212", userId: "u1" }));
    expect(out.success).toBe(false);
    const asn = out.courses[0].pages.find((p: any) => p.pageType === "assignments");
    expect(asn.ingested).toBe(false);
    // Complete rollback ⇒ zero committed rows for the page.
    expect(asn.itemsCommitted).toBe(0);
    expect(asn.tasksCommitted).toBe(0);
    expect(asn.snapshotsCommitted).toBe(0);
    expect(asn.failedStage).toBe(stage);
    expect(asn.failedSourceRef).toBe("SE212|1269|assignments|assignment-1");
    const f = out.failures.find((x: any) => x.stage === stage);
    expect(f).toBeTruthy();
  });

  it("accurate wording: internal state mutated, external fetch read-only", async () => {
    stubSE212AllOk();
    const out = JSON.parse(await CourseWebsiteTools.refresh_course_websites.handler({ courseCode: "SE212", userId: "u1" }));
    expect(out.note).toMatch(/external website fetches are read-only/i);
    expect(out.note).toMatch(/mutated Horizon's internal/i);
    expect(out.note).not.toMatch(/^Read-only ingestion complete/);
  });
});

// ─── get_course_website_content: read-only + isolation + read failure ────────

describe("get_course_website_content", () => {
  beforeEach(() => resetDb());
  it("scopes reads to the requesting user + course; does no network", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await CourseWebsiteTools.get_course_website_content.handler({ courseCode: "CS241", term: FALL_2026, userId: "userA" });
    const reads = db.recorded.filter((r) => r.table === "course_website_items" && r.op === "select");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.filters!.user_id === "userA" && r.filters!.course_code === "CS241")).toBe(true);
    expect((globalThis.fetch as any).mock.calls.length).toBe(0);
  });
  it("surfaces a read failure as success:false", async () => {
    vi.stubGlobal("fetch", vi.fn());
    db.failOn.itemsRead = true;
    const out = JSON.parse(await CourseWebsiteTools.get_course_website_content.handler({ courseCode: "CS241", userId: "u1" }));
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/read/i);
  });
});

// ─── Secret / cookie redaction + stable source_ref ───────────────────────────

describe("secret redaction + source_ref", () => {
  beforeEach(() => resetDb());
  it("source_ref is stable/slugged; sanitizer strips cookies/authorization", async () => {
    expect(sourceRefFor(SE212_FALL_2026, "assignments", "Assignment 1: Logic")).toBe("SE212|1269|assignments|assignment-1-logic");
    await recordSnapshotOnly({ userId: "u1", source: SE212_FALL_2026, pageType: "home", fetch: mkFetch("https://student.cs.uwaterloo.ca/~se212/", "Set-Cookie: secret=abc; Authorization: Bearer tok123"), parseStatus: "skipped", parseError: null });
    const ins = db.recorded.find((r) => r.table === "course_website_snapshots" && r.op === "insert")!;
    expect(ins.row.payload).not.toMatch(/secret=abc/);
    expect(ins.row.payload).toContain("[redacted]");
  });
  it("buildTaskRows only emits dated assessment items", () => {
    const items = buildCanonicalItems("u1", SE212_FALL_2026, "assignments", "u", [
      { itemType: "assignment", title: "A1", dueText: "x", dueAtIso: "2026-09-25T21:00:00.000Z", points: null, url: "https://x/a1", statusNote: null },
      { itemType: "lecture", title: "L1", dueText: "x", dueAtIso: "2026-09-08T14:00:00.000Z", points: null, url: null, statusNote: null },
      { itemType: "assignment", title: "A2 undated", dueText: null, dueAtIso: null, points: null, url: null, statusNote: null },
    ]);
    const rows = buildTaskRows(items);
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).source_ref).toContain("a1");
  });
});
