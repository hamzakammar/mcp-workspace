/**
 * Per-course website source configuration.
 *
 * A single generic shape drives the connector — no per-course scrapers. Each
 * config declares exactly which origins and URLs are allowed, how to classify a
 * page, which parser strategy to run, the course timezone, a freshness threshold,
 * and the content we expect (used for coverage/health reporting). Same-origin link
 * discovery is permitted ONLY against an explicit allowlist of URL patterns.
 */

export type PageType =
  | "home"
  | "schedule"
  | "assignments"
  | "notes"
  | "tutorials"
  | "policies"
  | "announcements"
  | "reference";

export type ParserStrategy =
  | "generic"        // links + headings + text
  | "se212-assignments"
  | "se212-schedule"
  | "cs241-assignments"
  | "cs241-schedule"
  | "notes-index";

export interface ApprovedUrl {
  url: string;
  pageType: PageType;
  parser: ParserStrategy;
  expectedContent?: string[]; // human-readable expectations for coverage reporting
}

export interface LinkDiscovery {
  enabled: boolean;
  /** A discovered same-origin link is fetched only if it matches one of these. */
  allowPatterns: RegExp[];
  /** Link targets recorded as source references but NOT fetched (e.g. PDFs, George). */
  referenceOnlyPatterns: RegExp[];
}

export interface CourseWebsiteSource {
  courseCode: string;
  term: string;                 // YYMM-style term id, e.g. '1269' for Fall 2026
  timezone: string;             // IANA tz, e.g. 'America/Toronto'
  allowedOrigins: string[];     // exact scheme+host[:port] allowed for fetch/redirect
  approvedUrls: ApprovedUrl[];
  linkDiscovery: LinkDiscovery;
  freshnessThresholdMs: number; // re-fetch only if the newest snapshot is older than this
  /** Known submission-status blind spots we cannot observe from public pages. */
  submissionBlindSpots: string[];
}

const STUDENT_CS = "https://student.cs.uwaterloo.ca";

// Fall 2026 term id (UW YYMM-style used elsewhere in Horizon: 1 + YY + termIndex).
export const FALL_2026 = "1269";

export const SE212_FALL_2026: CourseWebsiteSource = {
  courseCode: "SE212",
  term: FALL_2026,
  timezone: "America/Toronto",
  allowedOrigins: [STUDENT_CS],
  approvedUrls: [
    { url: `${STUDENT_CS}/~se212/`, pageType: "home", parser: "generic",
      expectedContent: ["course links", "announcements"] },
    { url: `${STUDENT_CS}/~se212/schedule.html`, pageType: "schedule", parser: "se212-schedule",
      expectedContent: ["weekly schedule", "lecture topics", "tutorial dates"] },
    { url: `${STUDENT_CS}/~se212/asn.html`, pageType: "assignments", parser: "se212-assignments",
      expectedContent: ["assignments", "due dates", "handout links"] },
    { url: `${STUDENT_CS}/~se212/notes.html`, pageType: "notes", parser: "notes-index",
      expectedContent: ["lecture notes", "slide/pdf links"] },
  ],
  linkDiscovery: {
    enabled: true,
    // Only follow same-origin SE212 course pages we explicitly allow.
    allowPatterns: [
      /^https:\/\/student\.cs\.uwaterloo\.ca\/~se212\/[a-z0-9._-]+\.html$/i,
    ],
    // George files (proof tool), submission systems, and linked PDFs are recorded as
    // references (and submission-status blind spots), never fetched.
    referenceOnlyPatterns: [
      /\.pdf($|\?)/i,
      /george/i,
      /markus/i,
      /crowdmark/i,
      /\.(zip|tar\.gz|jar)($|\?)/i,
    ],
  },
  freshnessThresholdMs: 6 * 60 * 60 * 1000, // 6h
  submissionBlindSpots: [
    "MarkUs submission status is not observable from public course pages",
    "Crowdmark grade/feedback status is not observable from public course pages",
  ],
};

export const CS241_FALL_2026: CourseWebsiteSource = {
  courseCode: "CS241",
  term: FALL_2026,
  timezone: "America/Toronto",
  allowedOrigins: [STUDENT_CS],
  approvedUrls: [
    { url: `${STUDENT_CS}/~cs241/`, pageType: "home", parser: "generic",
      expectedContent: ["links to assignments/schedule/notes/tutorials/policies"] },
    // Canonical page candidates. Exact filenames are confirmed during live
    // verification; discovery (below) also picks up the real same-origin pages.
    { url: `${STUDENT_CS}/~cs241/a/`, pageType: "assignments", parser: "cs241-assignments",
      expectedContent: ["A1 through A8", "exact due dates and times"] },
    { url: `${STUDENT_CS}/~cs241/schedule.shtml`, pageType: "schedule", parser: "cs241-schedule",
      expectedContent: ["lecture schedule", "topics"] },
    { url: `${STUDENT_CS}/~cs241/notes.shtml`, pageType: "notes", parser: "notes-index",
      expectedContent: ["lecture notes / slides"] },
    { url: `${STUDENT_CS}/~cs241/tutorials.shtml`, pageType: "tutorials", parser: "generic",
      expectedContent: ["tutorial materials"] },
    { url: `${STUDENT_CS}/~cs241/policies.shtml`, pageType: "policies", parser: "generic",
      expectedContent: ["late policy", "academic integrity"] },
  ],
  linkDiscovery: {
    enabled: true,
    allowPatterns: [
      /^https:\/\/student\.cs\.uwaterloo\.ca\/~cs241\/[a-z0-9/._-]*\.(s?html)$/i,
      /^https:\/\/student\.cs\.uwaterloo\.ca\/~cs241\/a\/?$/i,
    ],
    referenceOnlyPatterns: [
      /\.pdf($|\?)/i,
      /markus/i,
      /crowdmark/i,
      /\.(zip|tar\.gz|jar)($|\?)/i,
    ],
  },
  freshnessThresholdMs: 6 * 60 * 60 * 1000,
  submissionBlindSpots: [
    "MarkUs submission status is not observable from public course pages",
    "Crowdmark grade/feedback status is not observable from public course pages",
    "Authenticated CS241 pages (if any) are treated as unavailable — auth is never bypassed",
  ],
};

export const COURSE_WEBSITE_SOURCES: CourseWebsiteSource[] = [
  SE212_FALL_2026,
  CS241_FALL_2026,
];

export function getSourceConfig(courseCode: string, term?: string): CourseWebsiteSource | undefined {
  const code = courseCode.replace(/\s+/g, "").toUpperCase();
  return COURSE_WEBSITE_SOURCES.find(
    (s) => s.courseCode.toUpperCase() === code && (!term || s.term === term),
  );
}
