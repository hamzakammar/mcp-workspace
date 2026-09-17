/**
 * Regression guard for the outline combined-row splitting + day-first date parsing
 * that lets SE 212's packed assessment rows surface as discrete A00 / A01 items with
 * correct America/Toronto due dates, and the "Asn#0" → A00 normalization.
 *
 * These back the Horizon2 assertions:
 *   - SE 212 A01 appears with a due date of September 22, 2026.
 *   - A0/A00 is a discrete row (so its submitted state can be preserved/deprioritized).
 */
import { describe, it, expect } from "vitest";
import { expandOutlineAssessments, parseOutlineSegmentDate } from "../../src/tools/notion.js";

describe("parseOutlineSegmentDate (day-first, America/Toronto)", () => {
  it("parses 'Tue 22 Sep at 9pm' to 2026-09-22 21:00 EDT (01:00Z next day)", () => {
    // Toronto is UTC-4 (EDT) on 2026-09-22, so 21:00 local == 01:00Z on the 23rd.
    expect(parseOutlineSegmentDate("Tue 22 Sep at 9pm", 2026)).toBe("2026-09-23T01:00:00.000Z");
  });

  it("parses 'Tue 15 Sep at 9pm' (A00)", () => {
    expect(parseOutlineSegmentDate("Tue 15 Sep at 9pm", 2026)).toBe("2026-09-16T01:00:00.000Z");
  });

  it("returns null when there is no time component", () => {
    expect(parseOutlineSegmentDate("Friday weekly", 2026)).toBeNull();
    expect(parseOutlineSegmentDate("22 Sep", 2026)).toBeNull();
  });

  it("handles minutes and 12am/12pm boundaries", () => {
    expect(parseOutlineSegmentDate("6 Oct at 12:30pm", 2026)).toBe("2026-10-06T16:30:00.000Z");
    expect(parseOutlineSegmentDate("6 Oct at 12am", 2026)).toBe("2026-10-06T04:00:00.000Z");
  });
});

describe("expandOutlineAssessments (split packed rows / normalize names)", () => {
  it("splits the REAL SE 212 packed row with NO separators between segments", () => {
    // Verbatim from outline.uwaterloo.ca (SE212, term 1269): note "9pmA02" — the
    // segments run together with no space/word-boundary between them.
    const out = expandOutlineAssessments([
      {
        name: "Assignments #1-5",
        date: "A01: Tue 22 Sep at 9pmA02: Tue 29 Sep at 9pmA03: Tue 27 Oct at 9pmA04: Tue 10 Nov at 9pmA05: Tue 1 Dec at 9pm",
        weight: "8 (remote)",
      },
    ]);
    expect(out.map((a) => a.name)).toEqual(["A01", "A02", "A03", "A04", "A05"]);
    // A01 must carry the Sep 22 date (the key Horizon2 assertion).
    expect(parseOutlineSegmentDate(out[0].date || "", 2026)).toBe("2026-09-23T01:00:00.000Z");
    expect(parseOutlineSegmentDate(out[1].date || "", 2026)).toBe("2026-09-30T01:00:00.000Z");
    // Times must NOT bleed across segments (no "9pmA02" contamination).
    expect(out[0].date).toBe("Tue 22 Sep at 9pm");
  });

  it("splits a combined 'A01: … A02: … A03: …' date field into discrete items", () => {
    const out = expandOutlineAssessments([
      {
        name: "Assignments #1-5",
        date: "A01: Tue 22 Sep at 9pm A02: Tue 29 Sep at 9pm A03: Tue 6 Oct at 9pm",
        weight: "25%",
      },
    ]);
    expect(out.map((a) => a.name)).toEqual(["A01", "A02", "A03"]);
    expect(out[0].date).toContain("22 Sep");
    expect(out[1].date).toContain("29 Sep");
    expect(out.every((a) => a.weight === "25%")).toBe(true);
    // And the split date parses to the asserted Sep 22 due date.
    expect(parseOutlineSegmentDate(out[0].date || "", 2026)).toBe("2026-09-23T01:00:00.000Z");
  });

  it("normalizes 'Asn#0' to A00", () => {
    const out = expandOutlineAssessments([{ name: "Asn#0", date: "Tue 15 Sep at 9pm" }]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("A00");
  });

  it("normalizes 'Assignment 0' to A00 and 'Assignment 3' to A03", () => {
    expect(expandOutlineAssessments([{ name: "Assignment 0" }])[0].name).toBe("A00");
    expect(expandOutlineAssessments([{ name: "Assignment 3" }])[0].name).toBe("A03");
  });

  it("splits project rows into P0N", () => {
    const out = expandOutlineAssessments([
      { name: "Project", date: "P01: Tue 6 Oct at 9pm P02: Tue 20 Oct at 9pm" },
    ]);
    expect(out.map((a) => a.name)).toEqual(["P01", "P02"]);
  });

  it("leaves ordinary single rows unchanged", () => {
    const out = expandOutlineAssessments([{ name: "Midterm", date: "Fri 24 Oct at 7pm", weight: "30%" }]);
    expect(out).toEqual([{ name: "Midterm", date: "Fri 24 Oct at 7pm", weight: "30%" }]);
  });

  it("does not split a single-segment date field (needs >= 2 segments)", () => {
    const out = expandOutlineAssessments([{ name: "Quiz", date: "A01: Tue 22 Sep at 9pm" }]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Quiz");
  });
});
