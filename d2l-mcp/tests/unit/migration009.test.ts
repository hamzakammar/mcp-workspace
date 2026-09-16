/**
 * Regression guard for migration 009_course_websites.sql.
 *
 * Root cause of a prod apply failure: the migration created a trigger that used
 * public.set_updated_at() without defining it, assuming schema.sql had run. This
 * test asserts the migration is SELF-CONTAINED: every trigger function it references
 * via `execute function public.<fn>` is defined earlier in the same file.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const migPath = path.resolve(here, "../../src/study/db/migrations/009_course_websites.sql");
const sql = fs.readFileSync(migPath, "utf8");

describe("migration 009 is self-contained", () => {
  it("defines every trigger function it references, before the referencing trigger", () => {
    const refRe = /execute\s+function\s+public\.([a-z0-9_]+)\s*\(/gi;
    const refs = [...sql.matchAll(refRe)];
    expect(refs.length).toBeGreaterThan(0);
    for (const m of refs) {
      const fn = m[1];
      const useIdx = m.index ?? 0;
      const defIdx = sql.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(`, "i"));
      expect(defIdx, `function public.${fn} must be defined in 009`).toBeGreaterThanOrEqual(0);
      expect(defIdx, `public.${fn} must be defined BEFORE its trigger`).toBeLessThan(useIdx);
    }
  });

  it("explicitly defines set_updated_at (the function that was previously missing in prod)", () => {
    expect(sql).toMatch(/create\s+or\s+replace\s+function\s+public\.set_updated_at\s*\(/i);
  });

  it("still creates the connector objects + append-only trigger + dedup index", () => {
    expect(sql).toMatch(/create table if not exists public\.course_website_snapshots/i);
    expect(sql).toMatch(/create table if not exists public\.course_website_items/i);
    expect(sql).toMatch(/create or replace function public\.ingest_course_website_page/i);
    expect(sql).toMatch(/course_website_snapshots_no_mutation/);
    expect(sql).toMatch(/uq_course_website_snapshots_dedup/);
  });
});
