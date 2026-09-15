/**
 * HTML parsers for course-website pages.
 *
 * One generic, layout-tolerant parser set — NOT bespoke per-course scrapers. Each
 * strategy scans structural blocks (rows / list items / links) and extracts
 * canonical academic items, always preserving the ORIGINAL date text alongside the
 * normalized America/Toronto instant. Parsers never throw on malformed HTML; they
 * return whatever they can and surface a parse error to the caller via try/catch at
 * the store layer.
 */

import * as cheerio from "cheerio";
import { zonedWallTimeToUtcIso } from "./timezone.js";
import type { CourseWebsiteSource, PageType, ParserStrategy } from "./sources.js";

export const PARSER_VERSION = "cw-parser@1";

export type ItemType =
  | "assignment" | "quiz" | "exam" | "project" | "deadline"
  | "lecture" | "tutorial" | "policy" | "announcement" | "reference";

export interface ParsedItem {
  itemType: ItemType;
  title: string;
  dueText: string | null;   // original source text, verbatim
  dueAtIso: string | null;  // normalized instant, null when no time is present
  points: string | null;
  url: string | null;
  statusNote: string | null;
}

export interface ParseResult {
  items: ParsedItem[];
  discoveredLinks: string[];                       // allowlisted same-origin pages to consider fetching
  references: Array<{ url: string; kind: string }>; // PDFs/George/MarkUs/Crowdmark — recorded, never fetched
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Extract a due date (+ optional time) from free text, preserving the original. */
export function extractDue(raw: string, fallbackYear: number, timeZone: string): { dueText: string | null; dueAtIso: string | null } {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return { dueText: null, dueAtIso: null };

  let y: number | null = null, mo: number | null = null, d: number | null = null;

  const monthRe = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i;
  const isoRe = /\b(\d{4})-(\d{2})-(\d{2})\b/;
  const slashRe = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/;

  let m: RegExpMatchArray | null;
  if ((m = text.match(monthRe))) {
    mo = MONTHS[m[1].toLowerCase().slice(0, 3)];
    d = Number(m[2]);
    y = m[3] ? Number(m[3]) : fallbackYear;
  } else if ((m = text.match(isoRe))) {
    y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
  } else if ((m = text.match(slashRe))) {
    mo = Number(m[1]); d = Number(m[2]); y = Number(m[3]);
  } else {
    return { dueText: null, dueAtIso: null };
  }
  if (!y || !mo || !d || mo < 1 || mo > 12 || d < 1 || d > 31) return { dueText: null, dueAtIso: null };

  // Time (searched across the whole segment).
  let h: number | null = null, mi = 0;
  let tm: RegExpMatchArray | null;
  if (/\bnoon\b/i.test(text)) { h = 12; mi = 0; }
  else if (/\bmidnight\b/i.test(text)) { h = 0; mi = 0; }
  else if ((tm = text.match(/\b(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?/i))) {
    h = Number(tm[1]); mi = Number(tm[2]);
    const ap = tm[3]?.toLowerCase().replace(/\./g, "");
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
  } else if ((tm = text.match(/\b(\d{1,2})\s*([ap]\.?m\.?)\b/i))) {
    h = Number(tm[1]); mi = 0;
    const ap = tm[2].toLowerCase().replace(/\./g, "");
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
  }

  if (h === null || h > 23 || mi > 59) {
    // Date only — never invent a time. Preserve the original text; leave instant null.
    return { dueText: text, dueAtIso: null };
  }
  const dueAtIso = zonedWallTimeToUtcIso({ year: y, month: mo, day: d, hour: h, minute: mi }, timeZone);
  return { dueText: text, dueAtIso };
}

function absoluteUrl(href: string, baseUrl: string): string | null {
  try { return new URL(href, baseUrl).toString(); } catch { return null; }
}

/**
 * Text of a block, joining table cells with spaces. cheerio's `.text()`
 * concatenates `<td>`s with no separator ("…2026Tutorial…"), which breaks
 * word-boundary detection; joining cells restores boundaries. Falls back to
 * `.text()` for non-table blocks (e.g. `<li>`).
 */
function blockText($: cheerio.CheerioAPI, el: any): string {
  const $el = $(el);
  const cells = $el.children("td, th");
  const raw = cells.length > 0
    ? cells.map((_i, c) => $(c).text()).get().join(" ")
    : $el.text();
  return raw.replace(/\s+/g, " ").trim();
}

const SUBMISSION_BLIND_SPOT = "Submission/grade status (MarkUs/Crowdmark) is not observable from public pages.";

/** Harvest links: same-origin allowlisted pages → discovery; refs (pdf/george/…) → references. */
function harvestLinks($: cheerio.CheerioAPI, baseUrl: string, source: CourseWebsiteSource): Pick<ParseResult, "discoveredLinks" | "references"> {
  const discovered = new Set<string>();
  const references: Array<{ url: string; kind: string }> = [];
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const abs = absoluteUrl(href, baseUrl);
    if (!abs) return;
    const refMatch = source.linkDiscovery.referenceOnlyPatterns.find((re) => re.test(abs));
    if (refMatch) {
      const kind = /\.pdf/i.test(abs) ? "pdf"
        : /george/i.test(abs) ? "george"
        : /markus/i.test(abs) ? "markus"
        : /crowdmark/i.test(abs) ? "crowdmark"
        : "file";
      references.push({ url: abs, kind });
      return;
    }
    if (source.linkDiscovery.enabled && source.linkDiscovery.allowPatterns.some((re) => re.test(abs))) {
      discovered.add(abs);
    }
  });
  return { discoveredLinks: [...discovered], references };
}

function classifyAssessment(text: string): ItemType | null {
  const t = text.toLowerCase();
  if (/\bquiz\b/.test(t)) return "quiz";
  if (/\b(midterm|final exam|final|exam)\b/.test(t)) return "exam";
  if (/\bproject\b/.test(t)) return "project";
  if (/\b(a\d{1,2}|assignment\s*\d+|assn\s*\d+|hw\s*\d+|homework\s*\d+|problem set|pset)\b/.test(t)) return "assignment";
  return null;
}

function deriveTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  // Prefer the segment before "due" for a concise title.
  const beforeDue = cleaned.split(/\bdue\b/i)[0].trim();
  const title = (beforeDue || cleaned).slice(0, 120).trim();
  return title || cleaned.slice(0, 120);
}

/** Generic assessment parser used for both SE212 and CS241 assignment pages. */
function parseAssessments($: cheerio.CheerioAPI, baseUrl: string, source: CourseWebsiteSource): ParsedItem[] {
  const items: ParsedItem[] = [];
  const seen = new Set<string>();
  const fallbackYear = 2000 + Number(source.term.slice(1, 3)); // '1269' → 2026

  // Candidate blocks: table rows and list items (layout-tolerant).
  $("tr, li").each((_i, el) => {
    const $el = $(el);
    // Skip nested containers that also contain their own rows/items to avoid dupes.
    if ($el.find("tr, li").length > 0) return;
    const text = blockText($, el);
    if (!text) return;
    const itemType = classifyAssessment(text);
    if (!itemType) return;
    const { dueText, dueAtIso } = extractDue(text, fallbackYear, source.timezone);
    // Require either a due date or an explicit "due" marker to treat as an assessment.
    if (!dueText && !/\bdue\b/i.test(text)) return;

    const title = deriveTitle(text);
    const key = title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    const link = $el.find("a[href]").first().attr("href");
    const url = link ? absoluteUrl(link, baseUrl) : null;
    const pointsMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:%|marks?|points?|pts?)/i);

    items.push({
      itemType,
      title,
      dueText,
      dueAtIso,
      points: pointsMatch ? pointsMatch[0] : null,
      url,
      statusNote: SUBMISSION_BLIND_SPOT,
    });
  });
  return items;
}

/** Schedule parser — lectures/tutorials as canonical schedule info (NOT assignments). */
function parseSchedule($: cheerio.CheerioAPI, baseUrl: string, source: CourseWebsiteSource): ParsedItem[] {
  const items: ParsedItem[] = [];
  const fallbackYear = 2000 + Number(source.term.slice(1, 3));
  $("tr").each((_i, el) => {
    const $el = $(el);
    if ($el.find("tr").length > 0) return;
    const text = blockText($, el);
    if (!text) return;
    const { dueText, dueAtIso } = extractDue(text, fallbackYear, source.timezone);
    // A schedule row must anchor on a date; header rows without dates are skipped.
    if (!dueText) return;
    const isTutorial = /tutorial/i.test(text);
    const link = $el.find("a[href]").first().attr("href");
    items.push({
      itemType: isTutorial ? "tutorial" : "lecture",
      title: deriveTitle(text),
      dueText,
      dueAtIso,
      points: null,
      url: link ? absoluteUrl(link, baseUrl) : null,
      statusNote: null,
    });
  });
  return items;
}

/** Notes/reference index — link list of lecture notes/slides/pdfs. */
function parseNotesIndex($: cheerio.CheerioAPI, baseUrl: string, source: CourseWebsiteSource): ParsedItem[] {
  const items: ParsedItem[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_i, el) => {
    const $el = $(el);
    const href = $el.attr("href");
    if (!href) return;
    const abs = absoluteUrl(href, baseUrl);
    if (!abs) return;
    const label = $el.text().replace(/\s+/g, " ").trim();
    if (!label) return;
    // Only keep links that look like notes/materials, not nav chrome.
    if (!/\.(pdf|pptx?|html?|txt|md)($|\?)/i.test(abs) && !/note|lecture|slide|reading|handout|chapter/i.test(label)) return;
    if (seen.has(abs)) return;
    seen.add(abs);
    items.push({
      itemType: "reference",
      title: label.slice(0, 120),
      dueText: null, dueAtIso: null, points: null,
      url: abs, statusNote: null,
    });
  });
  return items;
}

/** Generic page — announcements (best-effort) + link harvest only. */
function parseGenericItems($: cheerio.CheerioAPI, _baseUrl: string, pageType: PageType): ParsedItem[] {
  if (pageType !== "announcements" && pageType !== "home") return [];
  const items: ParsedItem[] = [];
  // Capture list items under an "announcement"/"news" heading.
  $("h1, h2, h3").each((_i, el) => {
    const heading = $(el).text().toLowerCase();
    if (!/announc|news|updates/.test(heading)) return;
    const list = $(el).nextAll("ul, ol").first();
    list.find("li").each((_j, li) => {
      const t = $(li).text().replace(/\s+/g, " ").trim();
      if (t) items.push({ itemType: "announcement", title: t.slice(0, 200), dueText: null, dueAtIso: null, points: null, url: null, statusNote: null });
    });
  });
  return items;
}

/** Main entry: parse a page's HTML per its strategy. Never throws on bad HTML. */
export function parsePage(html: string, url: string, pageType: PageType, strategy: ParserStrategy, source: CourseWebsiteSource): ParseResult {
  const $ = cheerio.load(html);
  const { discoveredLinks, references } = harvestLinks($, url, source);
  let items: ParsedItem[] = [];
  switch (strategy) {
    case "se212-assignments":
    case "cs241-assignments":
      items = parseAssessments($, url, source);
      break;
    case "se212-schedule":
    case "cs241-schedule":
      items = parseSchedule($, url, source);
      break;
    case "notes-index":
      items = parseNotesIndex($, url, source);
      break;
    case "generic":
    default:
      items = parseGenericItems($, url, pageType);
      break;
  }
  return { items, discoveredLinks, references };
}
