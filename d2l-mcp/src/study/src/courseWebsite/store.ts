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

// ── DB layer ────────────────────────────────────────────────────────────────

export type ParseStatus = "ok" | "failed" | "skipped";

/** A snapshot row as seen by the dedup lookup. */
export interface SnapshotDedupRow {
  id: string;
  content_hash: string | null;
  parser_version: string;
  parse_status: ParseStatus | string;
}

/**
 * Decide which prior snapshot (if any) a SUCCESSFUL parse may deduplicate against.
 *
 * A successful parse may reuse a prior snapshot ONLY when it has the SAME
 * content_hash AND parser_version AND parse_status='ok'. This guarantees:
 *   - a previously FAILED parse of identical HTML is never reused as the provenance
 *     snapshot for successfully parsed canonical items;
 *   - a parser-version upgrade always produces a fresh snapshot (re-parse of record).
 * `existing` must already be scoped to (user, course, term, url) and ordered newest-
 * first; the newest qualifying snapshot is chosen.
 */
export function pickDedupSnapshotId(
  existing: SnapshotDedupRow[],
  contentHash: string | null,
  parserVersion: string,
): string | null {
  if (!contentHash) return null;
  for (const s of existing) {
    if (s.parse_status === "ok" && s.parser_version === parserVersion && s.content_hash === contentHash) {
      return s.id;
    }
  }
  return null;
}

/** Build the eligible `tasks` rows (dated assessments) for the canonical read path. */
export function buildTaskRows(items: CanonicalItem[]): Array<Record<string, unknown>> {
  const assessmentTypes = new Set<ItemType>(["assignment", "quiz", "exam", "project", "deadline"]);
  return items
    .filter((it) => assessmentTypes.has(it.itemType) && it.dueAt)
    .map((it) => ({
      user_id: it.userId,
      source_ref: it.sourceRef,
      course_id: it.courseCode,
      title: it.title,
      description: it.dueText ?? null,
      due_at: it.dueAt,
      links: it.url ? [it.url] : [],
    }));
}

export interface IngestResult {
  snapshotId: string | null;
  deduped: boolean;
  snapshotsInserted: number;
  itemsUpserted: number;
  tasksUpserted: number;
}

/** Structured persistence error identifying the failed stage + source_ref. */
export class PersistError extends Error {
  stage: "snapshot" | "canonical_item" | "task" | "ingest";
  sourceRef: string | null;
  constructor(message: string, stage: PersistError["stage"], sourceRef: string | null) {
    super(message);
    this.name = "PersistError";
    this.stage = stage;
    this.sourceRef = sourceRef;
  }
}

interface IngestPageArgs {
  userId: string;
  source: CourseWebsiteSource;
  pageType: PageType;
  fetch: FetchResult;
  extracted: unknown | null;
  items: CanonicalItem[];
}

/**
 * Atomically persist ONE successfully-parsed page: the snapshot, all canonical
 * items, and all eligible tasks — in a single PostgreSQL transaction via the
 * `ingest_course_website_page` RPC (a plpgsql function; any error inside it rolls
 * back every write). Dedup is NOT decided here: the RPC authoritatively enforces,
 * inside the transaction, that a successful parse reuses a prior snapshot only when
 * it matches the exact identity (user, course, term, url, content_hash,
 * parser_version) AND parse_status='ok'. On failure this throws a PersistError
 * (whose stage + source_ref come from the RPC's tagged error) and NOTHING is
 * committed for the page (append-only rule preserved: snapshots are only INSERTed).
 */
export async function ingestPage(args: IngestPageArgs): Promise<IngestResult> {
  const { userId, source, pageType, fetch: f } = args;
  const hash = f.body ? contentHash(f.body) : null;

  // NOTE: deduplication is NOT decided here. The dedup invariant (reuse a prior
  // snapshot only when it matches the exact identity — user, course, term, url,
  // content_hash, parser_version — AND parse_status='ok') is enforced
  // AUTHORITATIVELY inside the ingest_course_website_page transaction, so no
  // app-chosen snapshot id is trusted as provenance. `pickDedupSnapshotId` is the
  // pure, unit-tested specification of that same rule (see store tests).
  const payload = {
    user_id: userId,
    course_code: source.courseCode,
    term: source.term,
    url: f.finalUrl,
    page_type: pageType,
    http_status: f.httpStatus,
    fetch_outcome: f.outcome,
    parse_status: "ok" as ParseStatus,
    content_hash: hash,
    parser_version: PARSER_VERSION,
    source_updated_at: f.sourceUpdatedAt,
    payload: sanitize(f.body),
    extracted: args.extracted ?? null,
    error: null,
    items: args.items.map((it) => ({
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
      source_ref: it.sourceRef,
      source_url: it.sourceUrl,
      conflicts: it.conflicts,
    })),
    tasks: buildTaskRows(args.items),
  };

  const { data, error } = await supabase.rpc("ingest_course_website_page", { p_payload: payload });
  if (error) {
    // The transaction rolled back — nothing was committed for this page.
    const parsed = parseStageFromError(error.message);
    throw new PersistError(`atomic page ingest failed for ${f.finalUrl}: ${error.message}`, parsed.stage, parsed.sourceRef);
  }
  const r = (data ?? {}) as { snapshot_id?: string; deduped?: boolean; snapshots_inserted?: number; items_upserted?: number; tasks_upserted?: number };
  return {
    snapshotId: r.snapshot_id ?? null,
    deduped: !!r.deduped,
    snapshotsInserted: r.snapshots_inserted ?? 0,
    itemsUpserted: r.items_upserted ?? 0,
    tasksUpserted: r.tasks_upserted ?? 0,
  };
}

/** Best-effort extraction of stage/source_ref hints from a PG/RPC error message. */
function parseStageFromError(message: string): { stage: PersistError["stage"]; sourceRef: string | null } {
  const stageMatch = message.match(/stage=([a-z_]+)/i);
  const refMatch = message.match(/source_ref=([^\s]+)/i);
  const raw = stageMatch?.[1];
  const stage: PersistError["stage"] =
    raw === "snapshot" || raw === "canonical_item" || raw === "task" ? raw : "ingest";
  return { stage, sourceRef: refMatch?.[1] ?? null };
}

interface RecordSnapshotOnlyArgs {
  userId: string;
  source: CourseWebsiteSource;
  pageType: PageType;
  fetch: FetchResult;
  parseStatus: ParseStatus;   // 'failed' (parse error) or 'skipped' (non-content)
  parseError: string | null;
}

/**
 * Record a snapshot ONLY (no canonical items / tasks) for a parse failure or a
 * non-content fetch outcome. A single INSERT is inherently atomic. These are always
 * appended as distinct historical events — never deduplicated — so a failed parse
 * stays a distinct record and never becomes provenance for successful items.
 */
export async function recordSnapshotOnly(args: RecordSnapshotOnlyArgs): Promise<{ snapshotId: string | null }> {
  const { userId, source, pageType, fetch: f } = args;
  const hash = isContentOutcome(f.outcome) && f.body ? contentHash(f.body) : null;
  const row = {
    user_id: userId,
    course_code: source.courseCode,
    term: source.term,
    url: f.finalUrl,
    page_type: pageType,
    http_status: f.httpStatus,
    fetch_outcome: f.outcome,
    parse_status: args.parseStatus,
    content_hash: hash,
    parser_version: PARSER_VERSION,
    source_updated_at: f.sourceUpdatedAt,
    fetched_at: new Date().toISOString(),
    payload: isContentOutcome(f.outcome) ? sanitize(f.body) : null,
    extracted: null,
    error: args.parseError ?? f.error ?? null,
  };
  const { data, error } = await supabase
    .from("course_website_snapshots")
    .insert(row)
    .select("id")
    .maybeSingle();
  if (error) {
    throw new PersistError(`snapshot insert failed for ${f.finalUrl}: ${error.message}`, "snapshot", null);
  }
  return { snapshotId: (data as { id?: string } | null)?.id ?? null };
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

/**
 * Load website-derived ASSESSMENT items (with a due date) for a course+term, for the
 * Notion sync to merge as an additional source of truth. Read-only; returns cleaned
 * display names (trailing parenthetical stripped) so they dedupe cleanly against D2L/
 * outline items. Best-effort: returns [] on error (never blocks/erases the sync).
 */
export async function loadWebsiteAssessmentsForCourse(
  userId: string, courseCode: string, term: string,
): Promise<Array<{ name: string; dueAt: string | null; url: string | null; points: string | null; sourceRef: string }>> {
  const assessmentTypes = ["assignment", "quiz", "exam", "project", "deadline"];
  const { data, error } = await supabase
    .from("course_website_items")
    .select("item_type, title, due_at, url, points, source_ref")
    .eq("user_id", userId)
    .eq("course_code", courseCode)
    .eq("term", term)
    .in("item_type", assessmentTypes);
  if (error || !data) return [];
  return (data as Array<{ item_type: string; title: string; due_at: string | null; url: string | null; points: string | null; source_ref: string }>)
    .filter((r) => r.due_at) // only dated assessments are meaningful in the sync
    .map((r) => ({
      name: r.title.replace(/\s*\(.*$/s, "").trim() || r.title.trim(),
      dueAt: r.due_at,
      url: r.url,
      points: r.points,
      sourceRef: r.source_ref,
    }));
}

/**
 * Load upcoming connector-derived tasks (course website + outline) for the priority
 * tools ("what should I work on"). Reads the `tasks` table for source in
 * ('website','outline'), still open, with a due date in [sinceIso, untilIso]. Optionally
 * scope to a single normalized course code. course_id is the normalized course code
 * (e.g. "CS241"); title is cleaned of any trailing parenthetical. Best-effort: [] on error.
 */
export async function loadUpcomingConnectorTasks(
  userId: string, sinceIso: string, untilIso: string, courseCode?: string,
): Promise<Array<{ courseCode: string; title: string; dueAt: string; url: string | null }>> {
  let query = supabase
    .from("tasks")
    .select("course_id, title, due_at, links, status")
    .eq("user_id", userId)
    .in("source", ["website", "outline"])
    .not("due_at", "is", null)
    .gte("due_at", sinceIso)
    .lte("due_at", untilIso);
  if (courseCode) query = query.eq("course_id", courseCode);
  const { data, error } = await query;
  if (error || !data) return [];
  return (data as Array<{ course_id: string; title: string; due_at: string; links: unknown; status: string | null }>)
    .filter((r) => {
      const s = (r.status ?? "open").toLowerCase();
      return s !== "done" && s !== "completed" && s !== "submitted";
    })
    .map((r) => ({
      courseCode: r.course_id,
      title: (r.title || "").replace(/\s*\(.*$/s, "").trim() || (r.title || "").trim(),
      dueAt: r.due_at,
      url: Array.isArray(r.links) && r.links.length ? String(r.links[0]) : null,
    }));
}

/**
 * Persist outline-derived dated assessments to the `tasks` table (source='outline') so
 * the priority tools can surface them. UPDATE-then-INSERT keyed by a stable source_ref
 * (matches the constraint-free task-write pattern used elsewhere), preserving a row's
 * identity — and therefore any user-set status — across refreshes. Best-effort per row.
 */
export async function upsertOutlineTasks(
  userId: string,
  rows: Array<{ courseCode: string; name: string; dueAt: string }>,
): Promise<void> {
  const nowIso = new Date().toISOString();
  for (const r of rows) {
    const sourceRef = `outline|${r.courseCode}|${slug(r.name)}`;
    const { data: existing, error: selErr } = await supabase
      .from("tasks")
      .select("id")
      .eq("user_id", userId).eq("source", "outline").eq("source_ref", sourceRef)
      .limit(1);
    if (selErr) continue;
    if (existing && existing.length > 0) {
      await supabase.from("tasks").update({
        course_id: r.courseCode, title: r.name, due_at: r.dueAt, updated_at: nowIso,
      }).eq("user_id", userId).eq("source", "outline").eq("source_ref", sourceRef);
    } else {
      await supabase.from("tasks").insert({
        user_id: userId, source: "outline", source_ref: sourceRef, course_id: r.courseCode,
        title: r.name, description: null, due_at: r.dueAt, links: [], status: "open", updated_at: nowIso,
      });
    }
  }
}
