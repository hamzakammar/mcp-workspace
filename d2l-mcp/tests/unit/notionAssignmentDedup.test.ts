/**
 * Regression guard for cross-source assignment de-duplication.
 *
 * The SAME SE 212 assessment reaches the sync under different names from different
 * sources: the D2L calendar emits "SE212 Asn#1 due at 9pm via MarkUs" while the outline
 * calls it "A01" and a course website might say "Assignment 1". Before this fix each
 * appeared as its own bullet, so a single course page showed every assignment twice.
 *
 * canonicalAssignmentKey() collapses the well-known UW numbered patterns to a stable key
 * so they dedupe, while genuinely distinct items never collide.
 */
import { describe, it, expect } from "vitest";
import { canonicalAssignmentKey } from "../../src/tools/notion.js";

describe("canonicalAssignmentKey", () => {
  it("maps every naming of Assignment 1 to the same key", () => {
    const forms = [
      "SE212 Asn#1 due at 9pm via MarkUs",
      "Asn#1",
      "A01",
      "A1",
      "Assignment 1",
      "assignment #1",
    ];
    const keys = forms.map(canonicalAssignmentKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("a01");
  });

  it("keeps distinct assignment numbers distinct", () => {
    expect(canonicalAssignmentKey("Asn#0")).toBe("a00");
    expect(canonicalAssignmentKey("A00")).toBe("a00");
    expect(canonicalAssignmentKey("Assignment 10")).toBe("a10");
    expect(canonicalAssignmentKey("A01")).not.toBe(canonicalAssignmentKey("A02"));
  });

  it("collapses project namings", () => {
    expect(canonicalAssignmentKey("SE212 Project#1 due at 9pm via MarkUs")).toBe("p01");
    expect(canonicalAssignmentKey("Projects (1)")).toBe("p01");
    expect(canonicalAssignmentKey("P01")).toBe("p01");
  });

  it("collapses numbered midterms and quizzes", () => {
    expect(canonicalAssignmentKey("SE212 Midterm Exam 1")).toBe("midterm1");
    expect(canonicalAssignmentKey("Midterm Exam 1")).toBe("midterm1");
    expect(canonicalAssignmentKey("Midterm Exam 2")).toBe("midterm2");
    expect(canonicalAssignmentKey("Quiz #3")).toBe("quiz03");
  });

  it("does NOT collapse genuinely different items", () => {
    // No number → falls back to cleaned name; these stay distinct.
    expect(canonicalAssignmentKey("Final Exam")).toBe("final exam");
    expect(canonicalAssignmentKey("Final Project")).toBe("final project");
    expect(canonicalAssignmentKey("Participation")).toBe("participation");
    expect(canonicalAssignmentKey("Assignments")).toBe("assignments"); // plural, no number
    expect(canonicalAssignmentKey("Final Exam")).not.toBe(canonicalAssignmentKey("Final Project"));
    expect(canonicalAssignmentKey("Assignments")).not.toBe(canonicalAssignmentKey("Assignment 1"));
  });
});
