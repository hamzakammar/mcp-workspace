/**
 * MCP tools for the course-website ingestion connector.
 *
 *   get_course_website_content  — READ-ONLY. Reads previously-ingested canonical
 *                                 items + snapshot status from the DB. No network,
 *                                 no writes. → readOnlyHint: true.
 *
 *   refresh_course_websites     — Fetches approved public course pages read-only and
 *                                 PERSISTS: append-only snapshots, canonical items,
 *                                 and website-derived assessments into the canonical
 *                                 `tasks` read path. Because it mutates durable
 *                                 planning state (not just an incidental cache), it
 *                                 is honestly classified NON-read-only
 *                                 (readOnlyHint: false) so MCP clients approval-gate
 *                                 it. It NEVER writes to Notion, submits coursework,
 *                                 mutates external systems, or triggers background
 *                                 Notion sync.
 *
 * Preservation guarantee: only a fully successful, content-bearing fetch updates
 * canonical items/tasks for a page. Empty, failed, auth-required, blocked, or
 * unchanged fetches record a snapshot (history) but never delete or overwrite
 * existing academic records.
 */

import { z } from "zod";
import {
  COURSE_WEBSITE_SOURCES, getSourceConfig, type CourseWebsiteSource,
} from "./sources.js";
import { fetchPage } from "./fetcher.js";
import { parsePage } from "./parsers.js";
import {
  buildCanonicalItems, flagCrossSourceConflicts, ingestPage, recordSnapshotOnly,
  readCanonicalItems, readLatestSnapshots, isContentOutcome, loadOtherSourceDueByTitle,
  PersistError,
} from "./store.js";

const MAX_DISCOVERED_PER_SOURCE = 8;

interface PageReport {
  url: string;
  pageType: string;
  approved: boolean;            // an approved page vs a best-effort discovered link
  fetchOutcome: string;         // did the external fetch succeed?
  parseStatus: "ok" | "failed" | "skipped"; // did parsing succeed? (independent of fetch)
  httpStatus: number | null;
  succeeded: boolean;           // fetch ok + parse ok + fully persisted
  ingested: boolean;            // were canonical items/tasks persisted for this page?
  // Exact COMMITTED counts (atomic per page: all-or-nothing). Zero on any failure.
  snapshotsCommitted: number;
  itemsCommitted: number;
  tasksCommitted: number;
  itemsIngested: number;        // alias of itemsCommitted for report readability
  deduped: boolean;
  failedStage: "fetch" | "parse" | "snapshot" | "canonical_item" | "task" | "ingest" | null;
  failedSourceRef: string | null;
  persistError: string | null;  // a DB write failure for this page (never swallowed)
  note: string | null;
}

async function refreshSource(userId: string, source: CourseWebsiteSource): Promise<{ pages: PageReport[]; discovered: string[] }> {
  const nowIso = new Date().toISOString();
  const pages: PageReport[] = [];
  const fetched = new Set<string>();
  const discoveredAll = new Set<string>();

  // Cross-source (e.g. D2L) due dates for conflict flagging — best-effort, read-only.
  const otherDue = await loadOtherSourceDueByTitle(userId, source.courseCode).catch(() => new Map());

  const fetchOpts = {
    allowedOrigins: source.allowedOrigins,
    allowPatterns: source.linkDiscovery.allowPatterns,
  };

  const processOne = async (url: string, pageType: PageReport["pageType"], parser: string, approved: boolean): Promise<void> => {
    if (fetched.has(url)) return;
    fetched.add(url);

    const f = await fetchPage(url, fetchOpts);
    const base = {
      url: f.finalUrl, pageType, approved, fetchOutcome: f.outcome, httpStatus: f.httpStatus,
      deduped: false, snapshotsCommitted: 0, itemsCommitted: 0, tasksCommitted: 0, itemsIngested: 0,
      failedStage: null as PageReport["failedStage"], failedSourceRef: null as string | null,
      persistError: null as string | null,
    };

    if (isContentOutcome(f.outcome) && f.body) {
      // 1) Parse. A parse failure is NOT a successful ingestion — recorded with
      //    parse_status='failed' (a distinct historical snapshot) and never ingested.
      let parsed;
      try {
        parsed = parsePage(f.body, f.finalUrl, pageType as never, parser as never, source);
        parsed.discoveredLinks.forEach((l) => discoveredAll.add(l));
      } catch (e) {
        const note = `parser_error: ${e instanceof Error ? e.message : String(e)}`;
        let persistError: string | null = null;
        try {
          await recordSnapshotOnly({ userId, source, pageType: pageType as never, fetch: f, parseStatus: "failed", parseError: note });
        } catch (pe) {
          persistError = pe instanceof Error ? pe.message : String(pe);
        }
        pages.push({ ...base, parseStatus: "failed", succeeded: false, ingested: false,
          failedStage: persistError ? "snapshot" : "parse", persistError, note });
        return;
      }

      // 2) Atomic persist (snapshot + items + tasks) via the ingestion RPC. On any
      //    failure the whole page transaction rolls back — committed counts are 0.
      const flagged = flagCrossSourceConflicts(buildCanonicalItems(userId, source, pageType as never, f.finalUrl, parsed.items), otherDue, nowIso);
      try {
        const r = await ingestPage({ userId, source, pageType: pageType as never, fetch: f, extracted: parsed, items: flagged });
        pages.push({ ...base, parseStatus: "ok", succeeded: true, ingested: true,
          deduped: r.deduped, snapshotsCommitted: r.snapshotsInserted, itemsCommitted: r.itemsUpserted,
          tasksCommitted: r.tasksUpserted, itemsIngested: r.itemsUpserted, note: null });
      } catch (e) {
        const pe = e instanceof PersistError ? e : null;
        pages.push({ ...base, parseStatus: "ok", succeeded: false, ingested: false,
          failedStage: pe?.stage ?? "ingest", failedSourceRef: pe?.sourceRef ?? null,
          persistError: e instanceof Error ? e.message : String(e), note: null });
      }
    } else {
      // Non-content outcome (empty/http_error/auth_required/timeout/blocked/...).
      // Record history only; existing canonical items/tasks are preserved untouched.
      let persistError: string | null = null;
      try {
        await recordSnapshotOnly({ userId, source, pageType: pageType as never, fetch: f, parseStatus: "skipped", parseError: null });
      } catch (e) {
        persistError = e instanceof Error ? e.message : String(e);
      }
      pages.push({ ...base, parseStatus: "skipped", succeeded: false, ingested: false,
        failedStage: persistError ? "snapshot" : "fetch", persistError, note: f.error || f.outcome });
    }
  };

  for (const appr of source.approvedUrls) {
    await processOne(appr.url, appr.pageType, appr.parser, /*approved*/ true);
  }

  // Same-origin discovery: only allowlisted links, capped, not already fetched.
  const toDiscover = [...discoveredAll]
    .filter((u) => !fetched.has(u) && !source.approvedUrls.some((a) => a.url === u))
    .slice(0, MAX_DISCOVERED_PER_SOURCE);
  for (const url of toDiscover) {
    await processOne(url, "reference", "generic", /*approved*/ false);
  }

  return { pages, discovered: [...discoveredAll] };
}

export const CourseWebsiteTools = {
  get_course_website_content: {
    description:
      "Read previously-ingested course-website academic content (assignments, quizzes, " +
      "exams, deadlines, lecture/tutorial schedule, notes, policies, announcements, and " +
      "reference links) for a course + term, plus the latest fetch/snapshot status per " +
      "source page. READ-ONLY: reads only from Horizon's cache — no network, no writes. " +
      "Run refresh_course_websites first if content is missing or stale.",
    schema: {
      courseCode: z.string().describe('Course code, e.g. "SE212" or "CS241".'),
      term: z.string().optional().describe('Term id (YYMM-style, e.g. "1269" for Fall 2026). Defaults to the configured term.'),
    },
    handler: async ({ courseCode, term, userId }: { courseCode: string; term?: string; userId: string }): Promise<string> => {
      const source = getSourceConfig(courseCode, term);
      if (!source) {
        return JSON.stringify({ success: false, error: `No website source configured for ${courseCode}${term ? ` (term ${term})` : ""}.` }, null, 2);
      }
      let items: unknown[];
      let snapshots: unknown[];
      try {
        [items, snapshots] = await Promise.all([
          readCanonicalItems(userId, source.courseCode, source.term),
          readLatestSnapshots(userId, source.courseCode, source.term),
        ]);
      } catch (e) {
        return JSON.stringify({ success: false, error: `Failed to read course-website content: ${e instanceof Error ? e.message : String(e)}` }, null, 2);
      }
      return JSON.stringify({
        success: true,
        course: source.courseCode,
        term: source.term,
        timezone: source.timezone,
        items,
        snapshots,
        submissionBlindSpots: source.submissionBlindSpots,
      }, null, 2);
    },
  },

  refresh_course_websites: {
    description:
      "Fetch approved public course-website pages read-only and persist append-only " +
      "snapshots + normalized canonical academic items, integrating website-derived " +
      "assessments into Horizon's canonical assignment/deadline read path. Fetching is " +
      "SSRF-protected and restricted to an explicit allowlist. NON-read-only because it " +
      "writes durable planning data. It NEVER writes to Notion, submits coursework, or " +
      "triggers background Notion sync. Empty/failed/unavailable fetches preserve " +
      "existing records (absence is never treated as deletion or completion).",
    schema: {
      courseCode: z.string().optional().describe('Limit to one course, e.g. "SE212". Omit to refresh all configured courses.'),
      term: z.string().optional().describe('Term id (YYMM-style). Defaults to the configured term.'),
    },
    handler: async ({ courseCode, term, userId }: { courseCode?: string; term?: string; userId: string }): Promise<string> => {
      let sources: CourseWebsiteSource[];
      if (courseCode) {
        const s = getSourceConfig(courseCode, term);
        if (!s) return JSON.stringify({ success: false, error: `No website source configured for ${courseCode}${term ? ` (term ${term})` : ""}.` }, null, 2);
        sources = [s];
      } else {
        sources = COURSE_WEBSITE_SOURCES;
      }

      const results = [];
      const failures: Array<{ course: string; url: string; stage: string; outcome: string; error: string }> = [];
      const allPages: PageReport[] = [];
      for (const source of sources) {
        const { pages, discovered } = await refreshSource(userId, source);
        allPages.push(...pages);
        for (const p of pages) {
          const failedForSemantics =
            !!p.persistError || p.parseStatus === "failed" || (p.approved && p.fetchOutcome !== "success");
          if (failedForSemantics) {
            failures.push({
              course: source.courseCode,
              url: p.url,
              stage: p.failedStage ?? (p.persistError ? "persist" : p.parseStatus === "failed" ? "parse" : "fetch"),
              outcome: p.fetchOutcome,
              error: p.persistError ?? p.note ?? p.fetchOutcome,
            });
          }
        }
        results.push({
          course: source.courseCode,
          term: source.term,
          timezone: source.timezone,
          pages,
          discoveredLinks: discovered,
          submissionBlindSpots: source.submissionBlindSpots,
        });
      }

      // Result semantics:
      //   success = no page had a persistence failure, a parse failure, OR a
      //             non-successful fetch for an APPROVED page.
      //   partial = at least one page fully succeeded AND at least one page failed.
      //   fully successful → success:true, partial:false.
      //   completely failed → success:false, partial:false.
      const anyFailure = failures.length > 0;
      const anySuccess = allPages.some((p) => p.succeeded);
      const success = !anyFailure;
      const partial = anySuccess && anyFailure;

      return JSON.stringify({
        success,
        partial,
        // Accurate wording: the EXTERNAL website fetch is read-only, but this tool
        // MUTATES Horizon's internal state (append-only snapshots, canonical items,
        // and website-derived tasks). It never writes to Notion, submits coursework,
        // or triggers background Notion sync.
        note: "External website fetches are read-only; this tool mutated Horizon's internal snapshot, canonical-item, and task state. No Notion writes, no submissions, no background sync.",
        failures, // structured: { course, url, stage, outcome, error }
        courses: results,
      }, null, 2);
    },
  },
};
