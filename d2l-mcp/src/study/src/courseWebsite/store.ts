/**
 * Persistence + preservation layer for course-website ingestion.
 *
 * Core invariants (data-integrity first):
 *   - Snapshots are APPEND-ONLY. A content-bearing fetch whose normalized hash
 *     matches the newest stored snapshot for that URL is deduplicated (no new row);
 *     changed content always creates a new snapshot.
 *   - A failed / empty / auth-required fetch NEVER deletes or overwrites existing
 *     canonical items. Absence is never a delete, submission, or completion.
 *   - Canonical items are upserted idempotently. A value that changes over time is
 *     recorded in `conflicts` (flagged) rather than silently discarded; cross-source
 *     disagreements (website vs D2L) are flagged, never auto-resolved.
 *   - Assessment items with a concrete due time are integrated into the canonical
 *     `tasks` read path (source='website'); this only ever upserts, never deletes.
 *
 * Pure helpers (no DB) are exported for deterministic testing.
 */

import { createHash } from "node:crypto";
import { supabase } from "../../../utils/supabase.js";
import type { CourseWebsiteSource, PageType } from "./sources.js";
import type { FetchResult, FetchOutcome } from "./fetcher.js";
import { PARSER_VERSION, type ParsedItem, type ItemType } from "./parsers.js";

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** Normalized content hash (collapses whitespace so trivial reflow ≠ change). */
export function contentHash(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "item";
}

export function sourceRefFor(source: CourseWebsiteSource, pageType: PageType, title: string): string {
  return `${source.courseCode}|${source.term}|${pageType}|${slug(title)}`;
}

/** Outcomes that carry authoritative content we may normalize/persist as items. */
export function isContentOutcome(outcome: FetchOutcome): boolean {
  return outcome === "success";
}

export interface CanonicalItem {
  userId: string;
  courseCode: string;
  term: string;
  itemType: ItemType;
  title: string;
  dueAt: string | null;
  dueText: string | null;
  points: string | null;
  url: string | null;
  statusNote: string | null;
  source: "website";
  sourceRef: string;
  sourceUrl: string;
  conflicts: ConflictFlag[];
}

export interface ConflictFlag {
  field: string;
  kind: "temporal-change" | "cross-source";
  previous: string | null;
  current: string | null;
  otherSource?: string;
  seenAt: string;
}

/** Build canonical items (with stable source_ref) from a page's parsed items. */
export function buildCanonicalItems(
  userId: string,
  source: CourseWebsiteSource,
  pageType: PageType,
  sourceUrl: string,
  parsed: ParsedItem[],
): CanonicalItem[] {
  return parsed.map((p) => ({
    userId,
    courseCode: source.courseCode,
    term: source.term,
    itemType: p.itemType,
    title: p.title,
    dueAt: p.dueAtIso,
    dueText: p.dueText,
    points: p.points,
    url: p.url,
    statusNote: p.statusNote,
    source: "website" as const,
    sourceRef: sourceRefFor(source, pageType, p.title),
    sourceUrl,
    conflicts: [],
  }));
}

/**
 * Flag cross-source conflicts (website vs another source, e.g. D2L) WITHOUT
 * choosing a winner. `otherDueByTitle` maps a normalized title → the other
 * source's due ISO. Pure & side-effect free.
 */
export function flagCrossSourceConflicts(
  items: CanonicalItem[],
  otherDueByTitle: Map<string, { dueIso: string | null; source: string }>,
  nowIso: string,
): CanonicalItem[] {
  return items.map((it) => {
    const other = otherDueByTitle.get(normalizeTitle(it.title));
    if (!other) return it;
    if (it.dueAt && other.dueIso && it.dueAt !== other.dueIso) {
      return {
        ...it,
        conflicts: [
          ...it.conflicts,
          { field: "due_at", kind: "cross-source", previous: other.dueIso, current: it.dueAt, otherSource: other.source, seenAt: nowIso },
        ],
      };
    }
    return it;
  });
}

export function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9 ]/g, "").trim();
}

/** Decide whether a content fetch should create a new snapshot (append-only + dedup). */
export function shouldInsertSnapshot(latestHash: string | null, newHash: string | null, outcome: FetchOutcome): boolean {
  if (!isContentOutcome(outcome)) return true;         // always record non-content events as history
  if (newHash === null) return true;
  return latestHash !== newHash;                        // dedup unchanged content
}

// ── DB layer ────────────────────────────────────────────────────────────────

export type ParseStatus = "ok" | "failed" | "skipped";

interface RecordSnapshotArgs {
  userId: string;
  source: CourseWebsiteSource;
  pageType: PageType;
  fetch: FetchResult;
  extracted: unknown | null;
  parseError: string | null;
  /** PARSE result, independent of the fetch outcome. Defaults to 'skipped'. */
  parseStatus?: ParseStatus;
}

/**
 * Append a snapshot row (deduping unchanged content within the SAME
 * user+course+term+url scope). Throws on a DB write failure so callers can
 * surface persistence errors (never silently swallow).
 */
export async function recordSnapshot(args: RecordSnapshotArgs): Promise<{ snapshotId: string | null; deduped: boolean; hash: string | null }> {
  const { userId, source, pageType, fetch: f } = args;
  const parseStatus: ParseStatus = args.parseStatus ?? "skipped";
  const hash = isContentOutcome(f.outcome) && f.body ? contentHash(f.body) : null;

  // Dedup lookup is scoped to (user, course, term, final URL) so an identical URL
  // fetched under a different course or term NEVER dedups against or references
  // another course/term's snapshot.
  const { data: latest, error: latestErr } = await supabase
    .from("course_website_snapshots")
    .select("id, content_hash")
    .eq("user_id", userId)
    .eq("course_code", source.courseCode)
    .eq("term", source.term)
    .eq("url", f.finalUrl)
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestErr) {
    throw new Error(`snapshot lookup failed for ${f.finalUrl}: ${latestErr.message}`);
  }

  const latestHash: string | null = (latest as { content_hash?: string | null } | null)?.content_hash ?? null;

  if (!shouldInsertSnapshot(latestHash, hash, f.outcome)) {
    return { snapshotId: (latest as { id?: string } | null)?.id ?? null, deduped: true, hash };
  }

  const row = {
    user_id: userId,
    course_code: source.courseCode,
    term: source.term,
    url: f.finalUrl,
    page_type: pageType,
    http_status: f.httpStatus,
    fetch_outcome: f.outcome,
    parse_status: parseStatus,
    content_hash: hash,
    parser_version: PARSER_VERSION,
    source_updated_at: f.sourceUpdatedAt,
    fetched_at: new Date().toISOString(),
    payload: isContentOutcome(f.outcome) ? sanitize(f.body) : null,
    extracted: args.extracted ?? null,
    error: args.parseError ?? f.error ?? null,
  };
  const { data, error } = await supabase
    .from("course_website_snapshots")
    .insert(row)
    .select("id")
    .maybeSingle();
  if (error) {
    throw new Error(`snapshot insert failed for ${f.finalUrl}: ${error.message}`);
  }
  return { snapshotId: (data as { id?: string } | null)?.id ?? null, deduped: false, hash };
}

/**
 * Upsert canonical items. On a changed due date for an existing item, the previous
 * value is preserved in `conflicts` (flagged) rather than silently dropped. Failed/
 * empty fetches must NOT call this — callers skip persistence so old items survive.
 */
export async function upsertCanonicalItems(items: CanonicalItem[], snapshotId: string | null): Promise<number> {
  let written = 0;
  const nowIso = new Date().toISOString();
  for (const it of items) {
    const { data: existing, error: readErr } = await supabase
      .from("course_website_items")
      .select("id, due_at, conflicts, first_seen_at")
      .eq("user_id", it.userId)
      .eq("source", it.source)
      .eq("source_ref", it.sourceRef)
      .maybeSingle();
    if (readErr) {
      throw new Error(`item lookup failed (${it.sourceRef}): ${readErr.message}`);
    }

    const ex = existing as { id?: string; due_at?: string | null; conflicts?: ConflictFlag[]; first_seen_at?: string } | null;
    const conflicts: ConflictFlag[] = [...(ex?.conflicts ?? []), ...it.conflicts];
    if (ex && ex.due_at && it.dueAt && ex.due_at !== it.dueAt) {
      conflicts.push({ field: "due_at", kind: "temporal-change", previous: ex.due_at, current: it.dueAt, seenAt: nowIso });
    }

    const row = {
      user_id: it.userId,
      course_code: it.courseCode,
      term: it.term,
      item_type: it.itemType,
      title: it.title,
      due_at: it.dueAt,
      due_text: it.dueText,
      points: it.points,
      url: it.url,
      status_note: it.statusNote,
      source: it.source,
      source_ref: it.sourceRef,
      snapshot_id: snapshotId,
      source_url: it.sourceUrl,
      conflicts,
      last_seen_at: nowIso,
      updated_at: nowIso,
    };
    const { error } = await supabase
      .from("course_website_items")
      .upsert(row, { onConflict: "user_id,source,source_ref" });
    if (error) {
      throw new Error(`item upsert failed (${it.sourceRef}): ${error.message}`);
    }
    written++;
  }
  return written;
}

/**
 * Integrate assessment items with a concrete due time into the canonical `tasks`
 * read path (source='website'), so plan_week / tasks_list surface them. Only ever
 * UPSERTS — never deletes — so a later empty/failed fetch cannot remove a task.
 */
export async function integrateIntoTasks(items: CanonicalItem[]): Promise<number> {
  const assessmentTypes = new Set<ItemType>(["assignment", "quiz", "exam", "project", "deadline"]);
  const eligible = items.filter((it) => assessmentTypes.has(it.itemType) && it.dueAt);
  let written = 0;
  for (const it of eligible) {
    const row = {
      user_id: it.userId,
      source: "website",
      source_ref: it.sourceRef,
      course_id: it.courseCode,
      title: it.title,
      description: it.dueText ?? null,
      due_at: it.dueAt,
      links: it.url ? [it.url] : [],
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from("tasks").upsert(row, { onConflict: "user_id,source,source_ref" });
    if (error) { throw new Error(`task upsert failed (${it.sourceRef}): ${error.message}`); }
    written++;
  }
  return written;
}

/** Read cached canonical items (no network) for get_course_website_content. */
export async function readCanonicalItems(userId: string, courseCode: string, term: string): Promise<unknown[]> {
  const { data, error } = await supabase
    .from("course_website_items")
    .select("item_type, title, due_at, due_text, points, url, status_note, source_url, conflicts, last_seen_at")
    .eq("user_id", userId)
    .eq("course_code", courseCode)
    .eq("term", term)
    .order("due_at", { ascending: true });
  if (error) { throw new Error(`read canonical items failed: ${error.message}`); }
  return data ?? [];
}

export async function readLatestSnapshots(userId: string, courseCode: string, term: string): Promise<unknown[]> {
  const { data, error } = await supabase
    .from("course_website_snapshots")
    .select("url, page_type, fetch_outcome, parse_status, http_status, content_hash, source_updated_at, fetched_at, error")
    .eq("user_id", userId)
    .eq("course_code", courseCode)
    .eq("term", term)
    .order("fetched_at", { ascending: false })
    .limit(50);
  if (error) { throw new Error(`read snapshots failed: ${error.message}`); }
  return data ?? [];
}

/**
 * Load due dates from OTHER sources (e.g. D2L-synced tasks, source != 'website')
 * for a course, keyed by normalized title, so website items can flag cross-source
 * conflicts. Read-only; best-effort (returns empty on error).
 */
export async function loadOtherSourceDueByTitle(userId: string, courseCode: string): Promise<Map<string, { dueIso: string | null; source: string }>> {
  const out = new Map<string, { dueIso: string | null; source: string }>();
  const { data, error } = await supabase
    .from("tasks")
    .select("title, due_at, source")
    .eq("user_id", userId)
    .eq("course_id", courseCode)
    .neq("source", "website");
  if (error || !data) return out;
  for (const row of data as Array<{ title: string; due_at: string | null; source: string }>) {
    out.set(normalizeTitle(row.title), { dueIso: row.due_at, source: row.source });
  }
  return out;
}

/** Strip anything sensitive before persisting a payload (defense in depth). */
function sanitize(body: string | null): string | null {
  if (!body) return null;
  return body
    // Redact whole header VALUES, not just the header name, so no secret leaks.
    .replace(/set-cookie:\s*[^\n;]+/gi, "[redacted]")
    .replace(/\bcookie:\s*[^\n;]+/gi, "[redacted]")
    .replace(/authorization:\s*[^\n]+/gi, "[redacted]")
    .replace(/x-api-key:\s*[^\n]+/gi, "[redacted]")
    .replace(/bearer\s+[a-z0-9._-]+/gi, "[redacted]")
    .slice(0, 1_000_000);
}
