/**
 * Isolated test: a PARSER failure must never be reported as a successful ingestion.
 * parsePage is mocked to throw so we can exercise the fetch-success/parse-failure
 * path deterministically (kept in its own file so other tests use the real parser).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "142.150.1.1", family: 4 }] }));

const recorded: Array<{ table: string; op: string; row?: any }> = [];
const rpcCalls: string[] = [];
function reset() { recorded.length = 0; rpcCalls.length = 0; }

vi.mock("../../src/utils/supabase.js", () => {
  function makeQuery(table: string) {
    const state = { table, op: "select", row: undefined as any };
    const resolve = async () => {
      recorded.push({ table, op: state.op, row: state.row });
      if (state.op === "insert") return { data: { id: "snap-1" }, error: null };
      if (table === "course_website_snapshots") return { data: [], error: null };
      return { data: null, error: null };
    };
    const q: any = {};
    q.select = () => q; q.eq = () => q; q.neq = () => q; q.order = () => q; q.limit = () => q;
    q.insert = (row: any) => { state.op = "insert"; state.row = row; return q; };
    q.upsert = (row: any) => { state.op = "upsert"; state.row = row; return q; };
    q.maybeSingle = () => resolve();
    q.then = (res: any, rej: any) => resolve().then(res, rej);
    return q;
  }
  return { supabase: { from: (t: string) => makeQuery(t), rpc: async (name: string) => { rpcCalls.push(name); return { data: null, error: null }; } } };
});

// Force every parse to fail.
vi.mock("../../src/study/src/courseWebsite/parsers.js", () => ({
  PARSER_VERSION: "cw-parser@test",
  parsePage: () => { throw new Error("boom parse"); },
}));

import { CourseWebsiteTools } from "../../src/study/src/courseWebsite/tools.js";

const HTML = "<html><body><h1>x</h1></body></html>";

describe("parser failure is never a successful ingestion", () => {
  // Every approved page fetches OK (200) but parsing throws for all of them.
  beforeEach(() => { reset(); vi.stubGlobal("fetch", vi.fn(async () =>
    ({ status: 200, ok: true, headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "text/html" : null) }, body: null, text: async () => HTML }))); });

  it("records parse_status=failed, ingests nothing, and never reports success", async () => {
    const out = JSON.parse(await CourseWebsiteTools.refresh_course_websites.handler({ courseCode: "SE212", userId: "u1" }));
    // A parse failure means success:false. No page succeeded → not partial.
    expect(out.success).toBe(false);
    expect(out.partial).toBe(false);
    // Structured failures include a parse-stage failure for the assignments page.
    expect(out.failures.some((f: any) => f.stage === "parse" && /asn\.html/.test(f.url))).toBe(true);

    const asn = out.courses[0].pages.find((p: any) => p.pageType === "assignments");
    expect(asn.parseStatus).toBe("failed");
    expect(asn.ingested).toBe(false);
    expect(asn.itemsIngested).toBe(0);
    expect(asn.itemsCommitted).toBe(0);
    expect(asn.note).toMatch(/parser_error/);

    // A snapshot was recorded with parse_status=failed; NO items/tasks were written.
    const failedSnap = recorded.find((r) => r.table === "course_website_snapshots" && r.op === "insert" && r.row.parse_status === "failed");
    expect(failedSnap).toBeTruthy();
    // The atomic ingest RPC is never invoked for a parse failure (nothing ingested).
    expect(rpcCalls).not.toContain("ingest_course_website_page");
    expect(recorded.some((r) => r.table === "course_website_items" && r.op === "upsert")).toBe(false);
    expect(recorded.some((r) => r.table === "tasks" && r.op === "upsert")).toBe(false);
  });
});
