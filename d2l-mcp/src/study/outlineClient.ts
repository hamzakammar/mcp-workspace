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

  // Hard redirect to OIDC login (302/301) = session expired
  if (resp.status === 302 || resp.status === 301) {
    const loc = resp.headers.get("location") || "";
    if (loc.includes("oidc/login") || loc.includes("duosecurity")) {
      throw new OutlineAuthError();
    }
  }

  if (!resp.ok && resp.status !== 200) {
    throw new Error(`outline.uwaterloo.ca returned ${resp.status} for ${url}`);
  }

  const html = await resp.text();

  // The site sometimes returns a 200 page that performs a JS redirect to OIDC login
  // (instead of a 302). Detect by the redirect-parent element pointing to /oidc/.
  if (html.includes('id="redirect-parent"') && (html.includes('/oidc/') || html.includes('duosecurity'))) {
    throw new OutlineAuthError();
  }

  return html;
}

// ─── HTML parsing ─────────────────────────────────────────────────────────────

function parseAssessments($: cheerio.CheerioAPI): Assessment[] {
  const results: Assessment[] = [];

  // Look for a table with a header row containing "weight" or "component"
  $("table").each((_, table) => {
    // Include th elements anywhere in the table (thead or tbody), and also td in thead
    const headers = $(table).find("th, thead td").map((_, el) => $(el).text().trim().toLowerCase()).get();
    const hasWeight = headers.some(h =>
      h.includes("weight") || h.includes("%") || h.includes("value") || h.includes("mark") || h.includes("grade") || h.includes("worth")
    );
    const hasComponent = headers.some(h =>
      h.includes("component") || h.includes("assessment") || h.includes("activity") ||
      h.includes("item") || h.includes("evaluation") || h.includes("task") || h.includes("assignment")
    );
    if (!hasWeight && !hasComponent) return;

    // Find column positions — prefer named columns, fall back to positional
    const nameIdx = headers.findIndex(h =>
      h.includes("component") || h.includes("assessment") || h.includes("item") ||
      h.includes("activity") || h.includes("evaluation") || h.includes("task") || h.includes("assignment") || h === "name"
    );
    const weightIdx = headers.findIndex(h =>
      h.includes("weight") || h.includes("%") || h.includes("value") || h.includes("mark") || h.includes("worth") || h.includes("grade")
    );
    const dateIdx = headers.findIndex(h =>
      h.includes("date") || h.includes("due") || h.includes("deadline")
    );
    const notesIdx = headers.findIndex(h =>
      h.includes("note") || h.includes("comment") || h.includes("remark") || h.includes("detail")
    );

    $(table).find("tbody tr, tr").each((_, row) => {
      const cells = $(row).find("td").map((_, el) => $(el).text().trim()).get();
      if (cells.length < 2) return;

      // Skip header rows that sneak into tbody
      const firstCell = cells[0].toLowerCase();
      const skipWords = ["component", "assessment", "item", "activity", "evaluation", "task", "name"];
      if (skipWords.includes(firstCell)) return;
      if (!cells[0]) return;

      const ni = nameIdx >= 0 ? nameIdx : 0;
      const wi = weightIdx >= 0 ? weightIdx : 1;

      results.push({
        name: cells[ni] || cells[0],
        weight: cells[wi] || "",
        date: dateIdx >= 0 ? (cells[dateIdx] || undefined) : (cells[2] || undefined),
        notes: notesIdx >= 0 ? (cells[notesIdx] || undefined) : (cells[3] || undefined),
      });
    });
  });

  return results;
}

function parseSchedule($: cheerio.CheerioAPI): ScheduleRow[] {
  const results: ScheduleRow[] = [];

  $("table").each((_, table) => {
    const headers = $(table).find("th, thead td").map((_, el) => $(el).text().trim().toLowerCase()).get();
    const hasTopic = headers.some(h =>
      h.includes("topic") || h.includes("lecture") || h.includes("module") ||
      h.includes("content") || h.includes("description") || h.includes("section")
    );
    const hasWeekOrDate = headers.some(h =>
      h.includes("week") || h.includes("date") || h.includes("class") || h.includes("session")
    );
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

  // Fallback: table-based instructor info (some outlines use a staff table)
  if (results.length === 0) {
    $("table").each((_, table) => {
      const headers = $(table).find("th, thead td").map((_, el) => $(el).text().trim().toLowerCase()).get();
      if (!headers.some(h => h.includes("instructor") || h.includes("professor") || h.includes("lecturer") || h.includes("name"))) return;

      const emailIdx = headers.findIndex(h => h.includes("email"));
      const nameIdx = headers.findIndex(h => h.includes("name") || h.includes("instructor") || h.includes("professor") || h.includes("lecturer"));
      const officeIdx = headers.findIndex(h => h.includes("office") && !h.includes("hour"));
      const hoursIdx = headers.findIndex(h => h.includes("hour"));

      $(table).find("tbody tr").each((_, row) => {
        const cells = $(row).find("td").map((_, el) => $(el).text().trim()).get();
        if (cells.length === 0 || !cells[nameIdx >= 0 ? nameIdx : 0]) return;
        results.push({
          name: cells[nameIdx >= 0 ? nameIdx : 0],
          email: emailIdx >= 0 ? (cells[emailIdx] || undefined) : undefined,
          office: officeIdx >= 0 ? (cells[officeIdx] || undefined) : undefined,
          officeHours: hoursIdx >= 0 ? (cells[hoursIdx] || undefined) : undefined,
        });
      });
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
 * Get the current academic term string in UWaterloo's 4-digit format.
 * Format: 1YYT — where YY = last 2 digits of year, T = 1 (Winter), 5 (Spring), 9 (Fall)
 * Examples: 1261 = Winter 2026, 1265 = Spring 2026, 1259 = Fall 2025
 */
export function getCurrentTerm(): string {
  const now = new Date();
  const yy = String(now.getFullYear() % 100).padStart(2, "0");
  const month = now.getMonth() + 1;
  let termIndex: string;
  if (month >= 9) termIndex = "9";
  else if (month >= 5) termIndex = "5";
  else termIndex = "1";
  return `1${yy}${termIndex}`;
}
