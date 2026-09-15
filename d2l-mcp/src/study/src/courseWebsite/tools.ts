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
  recordSnapshot, buildCanonicalItems, flagCrossSourceConflicts, upsertCanonicalItems,
  integrateIntoTasks, readCanonicalItems, readLatestSnapshots, isContentOutcome,
  loadOtherSourceDueByTitle,
} from "./store.js";

const MAX_DISCOVERED_PER_SOURCE = 8;

interface PageReport {
  url: string;
  pageType: string;
  fetchOutcome: string;         // did the external fetch succeed?
  parseStatus: "ok" | "failed" | "skipped"; // did parsing succeed? (independent of fetch)
  httpStatus: number | null;
  ingested: boolean;            // were canonical items/tasks persisted for this page?
  itemsIngested: number;        // only > 0 when ingested === true
  deduped: boolean;
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

  const processOne = async (url: string, pageType: PageReport["pageType"], parser: string): Promise<void> => {
    if (fetched.has(url)) return;
    fetched.add(url);

    const f = await fetchPage(url, fetchOpts);
    let itemsIngested = 0;
    let deduped = false;
    let note: string | null = null;
    let parseStatus: PageReport["parseStatus"] = "skipped";
    let ingested = false;
    let persistError: string | null = null;

    if (isContentOutcome(f.outcome) && f.body) {
      // 1) Parse. A parse failure is NOT a successful ingestion — it is recorded
      //    with parse_status='failed' and never touches canonical items/tasks.
      let parsed;
      try {
        parsed = parsePage(f.body, f.finalUrl, pageType as never, parser as never, source);
        parseStatus = "ok";
        parsed.discoveredLinks.forEach((l) => discoveredAll.add(l));
      } catch (e) {
        parseStatus = "failed";
        note = `parser_error: ${e instanceof Error ? e.message : String(e)}`;
        try {
          await recordSnapshot({ userId, source, pageType: pageType as never, fetch: f, extracted: null, parseError: note, parseStatus: "failed" });
        } catch (pe) {
          persistError = `snapshot(parse-failure): ${pe instanceof Error ? pe.message : String(pe)}`;
        }
        pages.push({ url: f.finalUrl, pageType, fetchOutcome: f.outcome, parseStatus, httpStatus: f.httpStatus, ingested: false, itemsIngested: 0, deduped: false, persistError, note });
        return;
      }

      // 2) Persist snapshot → canonical items → tasks. ANY write failure aborts this
      //    page's ingestion, is surfaced as persistError, and never claims success.
      //    Existing data is preserved (upsert-only; nothing is deleted).
      try {
        const snap = await recordSnapshot({ userId, source, pageType: pageType as never, fetch: f, extracted: parsed, parseError: null, parseStatus: "ok" });
        deduped = snap.deduped;
        const flagged = flagCrossSourceConflicts(buildCanonicalItems(userId, source, pageType as never, f.finalUrl, parsed.items), otherDue, nowIso);
        await upsertCanonicalItems(flagged, snap.snapshotId);
        await integrateIntoTasks(flagged);
        itemsIngested = flagged.length;
        ingested = true;
      } catch (e) {
        persistError = e instanceof Error ? e.message : String(e);
        ingested = false;
        itemsIngested = 0; // never report items ingested when a write failed
      }
    } else {
      // Non-content outcome (empty/http_error/auth_required/timeout/blocked/...).
      // Record history only; existing canonical items/tasks are preserved untouched.
      note = f.error || f.outcome;
      try {
        await recordSnapshot({ userId, source, pageType: pageType as never, fetch: f, extracted: null, parseError: null, parseStatus: "skipped" });
      } catch (e) {
        persistError = `snapshot: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    pages.push({ url: f.finalUrl, pageType, fetchOutcome: f.outcome, parseStatus, httpStatus: f.httpStatus, ingested, itemsIngested, deduped, persistError, note });
  };

  for (const appr of source.approvedUrls) {
    await processOne(appr.url, appr.pageType, appr.parser);
  }

  // Same-origin discovery: only allowlisted links, capped, not already fetched.
  const toDiscover = [...discoveredAll]
    .filter((u) => !fetched.has(u) && !source.approvedUrls.some((a) => a.url === u))
    .slice(0, MAX_DISCOVERED_PER_SOURCE);
  for (const url of toDiscover) {
    await processOne(url, "reference", "generic");
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
      const persistErrors: string[] = [];
      const parseFailures: string[] = [];
      for (const source of sources) {
        const { pages, discovered } = await refreshSource(userId, source);
        for (const p of pages) {
          if (p.persistError) persistErrors.push(`${source.courseCode} ${p.url}: ${p.persistError}`);
          if (p.parseStatus === "failed") parseFailures.push(`${source.courseCode} ${p.url}`);
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

      // success is FALSE if any persistence write failed — never claim success when
      // internal state could not be durably written. partial flags parse failures
      // or fetch problems that did not fully ingest while other pages did.
      const success = persistErrors.length === 0;
      const partial = !success
        || parseFailures.length > 0
        || results.some((r) => r.pages.some((p) => !p.ingested && p.fetchOutcome === "success"))
        || results.some((r) => r.pages.some((p) => p.fetchOutcome !== "success"));

      return JSON.stringify({
        success,
        partial,
        // Accurate wording: the EXTERNAL website fetch is read-only, but this tool
        // MUTATES Horizon's internal state (append-only snapshots, canonical items,
        // and website-derived tasks). It never writes to Notion, submits coursework,
        // or triggers background Notion sync.
        note: "External website fetches are read-only; this tool mutated Horizon's internal snapshot, canonical-item, and task state. No Notion writes, no submissions, no background sync.",
        persistErrors,
        parseFailures,
        courses: results,
      }, null, 2);
    },
  },
};
