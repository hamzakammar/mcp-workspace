/**
 * Regression guard for enrichWithCourseWebsite — merging course_website_items into a
 * Notion sync so the public course site is a source of truth alongside D2L/outline.
 *
 * Backs the Horizon2 assertions:
 *   - CS 241 A1 appears with a due date of September 25, 2026 (website-only item added).
 *   - A website due date is authoritative for a matched assessment...
 *   - ...but NEVER downgrades an authoritative Submitted/Graded status (we can't observe
 *     submission from a public site) — SE 212 A0/A00 stays Submitted & deprioritized.
 *   - Malformed website rows whose cleaned name still embeds a date token are skipped,
 *     so we don't duplicate the outline's authoritative Project (P01) under a garbled title.
 *   - No duplicate tasks: a website item matching an existing assignment updates in place.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const loadWebsiteAssessmentsForCourse = vi.fn();
const getSourceConfig = vi.fn();

vi.mock("../../src/study/src/courseWebsite/store.js", () => ({
  loadWebsiteAssessmentsForCourse: (...a: unknown[]) => loadWebsiteAssessmentsForCourse(...a),
}));
vi.mock("../../src/study/src/courseWebsite/sources.js", () => ({
  getSourceConfig: (...a: unknown[]) => getSourceConfig(...a),
}));

import { enrichWithCourseWebsite } from "../../src/tools/notion.js";

type Course = Parameters<typeof enrichWithCourseWebsite>[0][number];

function course(partial: Partial<Course> & { code: string }): Course {
  return {
    name: partial.code,
    code: partial.code,
    assignments: partial.assignments ?? [],
    grades: [],
    announcements: [],
    schedule: [],
  } as unknown as Course;
}

beforeEach(() => {
  loadWebsiteAssessmentsForCourse.mockReset();
  getSourceConfig.mockReset();
  // Every course in these tests has a configured website source.
  getSourceConfig.mockReturnValue({ courseCode: "X", term: "1269" });
});

describe("enrichWithCourseWebsite", () => {
  it("adds a website-only assignment (CS 241 A1, Sep 25 2026)", async () => {
    loadWebsiteAssessmentsForCourse.mockResolvedValue([
      { name: "A1", dueAt: "2026-09-25T21:00:00.000Z", url: "https://x/a1", points: null, sourceRef: "cs241:a1" },
    ]);
    const c = course({ code: "CS241", assignments: [] });
    await enrichWithCourseWebsite([c], "u1");
    expect(c.assignments).toHaveLength(1);
    expect(c.assignments[0]).toMatchObject({ name: "A1", dueDate: "2026-09-25T21:00:00.000Z", status: "Not Started" });
  });

  it("treats the website due date as authoritative for a matched assessment", async () => {
    loadWebsiteAssessmentsForCourse.mockResolvedValue([
      { name: "A01", dueAt: "2026-09-22T21:00:00.000Z", url: null, points: null, sourceRef: "se212:a01" },
    ]);
    const c = course({
      code: "SE212",
      assignments: [{ name: "A01", dueDate: "2026-01-01T00:00:00.000Z", maxPoints: null, status: "Not Started" }],
    });
    await enrichWithCourseWebsite([c], "u1");
    expect(c.assignments).toHaveLength(1); // no duplicate
    expect(c.assignments[0].dueDate).toBe("2026-09-22T21:00:00.000Z"); // overwritten by website
  });

  it("never downgrades an authoritative Submitted status (A0 stays Submitted)", async () => {
    loadWebsiteAssessmentsForCourse.mockResolvedValue([
      { name: "A00", dueAt: "2026-09-15T21:00:00.000Z", url: null, points: null, sourceRef: "se212:a00" },
    ]);
    const c = course({
      code: "SE212",
      assignments: [{ name: "A00", dueDate: "2026-09-15T21:00:00.000Z", maxPoints: null, status: "Submitted" }],
    });
    await enrichWithCourseWebsite([c], "u1");
    expect(c.assignments[0].status).toBe("Submitted");
  });

  it("skips malformed website rows whose name still embeds a date token", async () => {
    loadWebsiteAssessmentsForCourse.mockResolvedValue([
      { name: "Project handout posted 17 Nov", dueAt: "2026-11-17T05:00:00.000Z", url: null, points: null, sourceRef: "se212:proj" },
    ]);
    const c = course({ code: "SE212", assignments: [] });
    await enrichWithCourseWebsite([c], "u1");
    expect(c.assignments).toHaveLength(0);
  });

  it("skips courses without a configured website source", async () => {
    getSourceConfig.mockReturnValue(undefined);
    const c = course({ code: "PSYCH207", assignments: [] });
    await enrichWithCourseWebsite([c], "u1");
    expect(loadWebsiteAssessmentsForCourse).not.toHaveBeenCalled();
    expect(c.assignments).toHaveLength(0);
  });

  it("swallows store errors and leaves existing data intact", async () => {
    loadWebsiteAssessmentsForCourse.mockRejectedValue(new Error("db down"));
    const c = course({
      code: "CS241",
      assignments: [{ name: "A1", dueDate: "2026-09-25T21:00:00.000Z", maxPoints: null, status: "Not Started" }],
    });
    await expect(enrichWithCourseWebsite([c], "u1")).resolves.toBeUndefined();
    expect(c.assignments).toHaveLength(1);
  });
});
