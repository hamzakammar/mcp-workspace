/**
 * Outline Client — fetches and parses course outline HTML from outline.uwaterloo.ca.
 *
 * URL patterns (discovered empirically; raw_html is always stored so parsing
 * can be iterated without re-fetching):
 *   List:    https://outline.uwaterloo.ca/viewer/org/uwaterloo/
 *   Outline: https://outline.uwaterloo.ca/viewer/course/{subject}/{number}/{term}/
 *            e.g. /viewer/course/cs/135/1251/
 *
 * The site is Django-rendered HTML. Parsing targets:
 *   - Assessments table (Component / Weight / Due Date)
 *   - Weekly schedule table
 *   - Instructor section
 *   - Learning objectives list
 */

import * as cheerio from "cheerio";

const OUTLINE_BASE = "https://outline.uwaterloo.ca";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Assessment {
  name: string;
  weight: string;
  date?: string;
  notes?: string;
}

export interface ScheduleRow {
  week?: string;
  date?: string;
  topic: string;
  readings?: string;
}

export interface Instructor {
  name: string;
  email?: string;
  office?: string;
  officeHours?: string;
}

export interface ParsedOutline {
  title: string | null;
  courseCode: string;
  term: string;
  outlineUrl: string;
  assessments: Assessment[];
  schedule: ScheduleRow[];
  instructors: Instructor[];
  learningObjectives: string[];
  rawHtml: string;
}

export class OutlineAuthError extends Error {
  constructor() {
    super("outline_auth_required");
    this.name = "OutlineAuthError";
  }
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

/**
 * Split a course code like "CS135" or "MATH135" into subject + number.
 * Returns ["cs", "135"].
 */
function splitCourseCode(courseCode: string): [string, string] {
  const m = courseCode.trim().match(/^([A-Za-z]+)\s*(\d+[A-Za-z]?)$/);
  if (!m) throw new Error(`Cannot parse course code: ${courseCode}`);
  return [m[1].toLowerCase(), m[2]];
}

/** Build the outline viewer URL for a course + term. */
export function buildOutlineUrl(courseCode: string, term: string): string {
  const [subject, number] = splitCourseCode(courseCode);
  return `${OUTLINE_BASE}/viewer/course/${subject}/${number}/${term}/`;
}

// ─── HTTP fetch ───────────────────────────────────────────────────────────────

async function fetchWithCookie(url: string, cookieHeader: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      "Cookie": cookieHeader,
      "Accept": "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (compatible; HorizonBot/1.0)",
    },
    redirect: "manual",
  });

  // Redirect to OIDC login = session expired
  if (resp.status === 302 || resp.status === 301) {
    const loc = resp.headers.get("location") || "";
    if (loc.includes("oidc/login") || loc.includes("duosecurity")) {
      throw new OutlineAuthError();
    }
  }

  if (!resp.ok && resp.status !== 200) {
    throw new Error(`outline.uwaterloo.ca returned ${resp.status} for ${url}`);
  }

  return resp.text();
}

// ─── HTML parsing ─────────────────────────────────────────────────────────────

function parseAssessments($: cheerio.CheerioAPI): Assessment[] {
  const results: Assessment[] = [];

  // Look for a table with a header row containing "weight" or "component"
  $("table").each((_, table) => {
    const headers = $(table).find("th, thead td").map((_, el) => $(el).text().trim().toLowerCase()).get();
    const hasWeight = headers.some(h => h.includes("weight") || h.includes("%"));
    const hasComponent = headers.some(h => h.includes("component") || h.includes("assessment") || h.includes("activity") || h.includes("item"));
    if (!hasWeight && !hasComponent) return;

    $(table).find("tbody tr, tr").each((i, row) => {
      const cells = $(row).find("td").map((_, el) => $(el).text().trim()).get();
      if (cells.length < 2) return;

      // Skip header rows that sneak into tbody
      const firstCell = cells[0].toLowerCase();
      if (firstCell === "component" || firstCell === "assessment" || firstCell === "item" || firstCell === "activity") return;
      if (!cells[0]) return;

      results.push({
        name: cells[0],
        weight: cells[1] || "",
        date: cells[2] || undefined,
        notes: cells[3] || undefined,
      });
    });
  });

  return results;
}

function parseSchedule($: cheerio.CheerioAPI): ScheduleRow[] {
  const results: ScheduleRow[] = [];

  $("table").each((_, table) => {
    const headers = $(table).find("th, thead td").map((_, el) => $(el).text().trim().toLowerCase()).get();
    const hasTopic = headers.some(h => h.includes("topic") || h.includes("lecture") || h.includes("module"));
    const hasWeekOrDate = headers.some(h => h.includes("week") || h.includes("date"));
    if (!hasTopic && !hasWeekOrDate) return;

    $(table).find("tbody tr, tr").each((_, row) => {
      const cells = $(row).find("td").map((_, el) => $(el).text().trim()).get();
      if (cells.length < 2) return;
      if (!cells[0] && !cells[1]) return;

      // Determine column positions from headers
      const weekIdx = headers.findIndex(h => h.includes("week"));
      const dateIdx = headers.findIndex(h => h.includes("date"));
      const topicIdx = headers.findIndex(h => h.includes("topic") || h.includes("lecture") || h.includes("module"));
      const readingsIdx = headers.findIndex(h => h.includes("reading") || h.includes("text"));

      results.push({
        week: weekIdx >= 0 ? cells[weekIdx] : cells[0],
        date: dateIdx >= 0 ? cells[dateIdx] : undefined,
        topic: topicIdx >= 0 ? (cells[topicIdx] || "") : (cells[1] || cells[0] || ""),
        readings: readingsIdx >= 0 ? cells[readingsIdx] : undefined,
      });
    });
  });

  return results;
}

function parseInstructors($: cheerio.CheerioAPI): Instructor[] {
  const results: Instructor[] = [];

  // Look for sections/divs with instructor-related text
  const instructorHeadings = $("h2, h3, h4, dt, th, strong, b").filter((_, el) => {
    const text = $(el).text().trim().toLowerCase();
    return text.includes("instructor") || text === "professor" || text === "lecturer" || text === "ta" || text === "teaching assistant";
  });

  instructorHeadings.each((_, heading) => {
    // Try to find structured data near the heading
    const section = $(heading).closest("section, div, table, dl");

    // Extract name, email, office from nearby text
    const fullText = section.text();
    const emailMatch = fullText.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
    const nameText = $(heading).next("p, dd, td").first().text().trim() ||
                     $(heading).parent().find("p, dd").first().text().trim();

    if (nameText) {
      results.push({
        name: nameText.split("\n")[0].trim(),
        email: emailMatch ? emailMatch[0] : undefined,
        office: undefined,
        officeHours: undefined,
      });
    }
  });

  // Fallback: look for definition lists (common in Django outline sites)
  if (results.length === 0) {
    $("dl").each((_, dl) => {
      const terms = $(dl).find("dt").map((_, el) => $(el).text().trim().toLowerCase()).get();
      if (!terms.some(t => t.includes("instructor") || t.includes("name") || t.includes("professor"))) return;

      const instructor: Instructor = { name: "" };
      $(dl).find("dt").each((_, dt) => {
        const key = $(dt).text().trim().toLowerCase();
        const val = $(dt).next("dd").text().trim();
        if (key.includes("name") || key.includes("instructor") || key.includes("professor")) instructor.name = val;
        else if (key.includes("email")) instructor.email = val;
        else if (key.includes("office") && !key.includes("hour")) instructor.office = val;
        else if (key.includes("hour")) instructor.officeHours = val;
      });

      if (instructor.name) results.push(instructor);
    });
  }

  return results;
}

function parseLearningObjectives($: cheerio.CheerioAPI): string[] {
  const results: string[] = [];

  // Find section with "learning objective" heading
  const heading = $("h1, h2, h3, h4").filter((_, el) =>
    $(el).text().trim().toLowerCase().includes("learning objective") ||
    $(el).text().trim().toLowerCase().includes("course objective") ||
    $(el).text().trim().toLowerCase().includes("course goal")
  ).first();

  if (heading.length) {
    // Collect list items following the heading
    heading.nextAll("ul, ol").first().find("li").each((_, li) => {
      const text = $(li).text().trim();
      if (text) results.push(text);
    });

    // Fallback: collect paragraph text following heading
    if (results.length === 0) {
      heading.nextAll("p").slice(0, 5).each((_, p) => {
        const text = $(p).text().trim();
        if (text) results.push(text);
      });
    }
  }

  return results;
}

function parseTitle($: cheerio.CheerioAPI): string | null {
  // Try the main H1 first
  const h1 = $("h1").first().text().trim();
  if (h1) return h1;

  // Fallback to page title
  const title = $("title").text().trim();
  return title || null;
}

// ─── Exported functions ───────────────────────────────────────────────────────

/**
 * Fetch and parse a specific course outline.
 * courseCode: e.g. "CS135" or "MATH135"
 * term: e.g. "1251" (required — outline URLs include the term)
 */
export async function fetchCourseOutline(
  cookieHeader: string,
  courseCode: string,
  term: string
): Promise<ParsedOutline> {
  const url = buildOutlineUrl(courseCode, term);
  console.error(`[OUTLINE_CLIENT] Fetching outline: ${url}`);

  const html = await fetchWithCookie(url, cookieHeader);
  const $ = cheerio.load(html);

  return {
    title: parseTitle($),
    courseCode: courseCode.toUpperCase(),
    term,
    outlineUrl: url,
    assessments: parseAssessments($),
    schedule: parseSchedule($),
    instructors: parseInstructors($),
    learningObjectives: parseLearningObjectives($),
    rawHtml: html,
  };
}

/**
 * Fetch the list of available outlines for the user's organization.
 * Returns an array of { courseCode, term, url } objects.
 */
export async function fetchMyOutlineList(cookieHeader: string): Promise<Array<{ courseCode: string; term: string; url: string }>> {
  const url = `${OUTLINE_BASE}/viewer/org/uwaterloo/`;
  console.error(`[OUTLINE_CLIENT] Fetching outline list from ${url}`);

  const html = await fetchWithCookie(url, cookieHeader);
  const $ = cheerio.load(html);
  const results: Array<{ courseCode: string; term: string; url: string }> = [];

  // Outline list pages typically have links like /viewer/course/cs/135/1251/
  $("a[href*='/viewer/course/']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const m = href.match(/\/viewer\/course\/([^/]+)\/([^/]+)\/([^/]+)\/?/);
    if (m) {
      results.push({
        courseCode: `${m[1].toUpperCase()}${m[2]}`,
        term: m[3],
        url: href.startsWith("http") ? href : `${OUTLINE_BASE}${href}`,
      });
    }
  });

  return results;
}

/**
 * Get the current academic term string in YYMM format.
 * UWaterloo terms: 01=Winter, 05=Spring, 09=Fall
 */
export function getCurrentTerm(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const month = now.getMonth() + 1;
  let termMonth: string;
  if (month >= 9) termMonth = "09";
  else if (month >= 5) termMonth = "05";
  else termMonth = "01";
  return `${yy}${termMonth}`;
}
