/**
 * Regression guard for migration 010 (ingest RPC task write).
 *
 * Root cause of a prod refresh failure: the 009 RPC upserted website tasks with
 * `on conflict (user_id, source, source_ref)`, but production's public.tasks has no
 * unique index on those columns (the rest of the codebase — sync.ts, tasks_add —
 * writes tasks via check-exists-then-insert). 010 redefines the RPC so the TASK
 * write uses UPDATE-then-INSERT (constraint-free). This test asserts that.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.resolve(here, "../../src/study/db/migrations/010_fix_ingest_tasks_upsert.sql"), "utf8");

describe("migration 010: ingest RPC task write is constraint-free", () => {
  it("redefines ingest_course_website_page", () => {
    expect(sql).toMatch(/create or replace function public\.ingest_course_website_page\s*\(/i);
  });

  it("writes tasks via UPDATE-then-INSERT (no ON CONFLICT on public.tasks)", () => {
    expect(sql).toMatch(/update public\.tasks set/i);
    expect(sql).toMatch(/if not found then[\s\S]{0,200}insert into public\.tasks/i);
    // The tasks INSERT statement must NOT rely on ON CONFLICT.
    const idx = sql.toLowerCase().indexOf("insert into public.tasks");
    expect(idx).toBeGreaterThan(0);
    const stmt = sql.slice(idx, sql.indexOf(";", idx)).toLowerCase();
    expect(stmt).not.toContain("on conflict");
  });

  it("still upserts canonical items via ON CONFLICT (course_website_items has its unique constraint)", () => {
    expect(sql).toMatch(/insert into public\.course_website_items[\s\S]*?on conflict\s*\(user_id, source, source_ref\)/i);
  });
});
