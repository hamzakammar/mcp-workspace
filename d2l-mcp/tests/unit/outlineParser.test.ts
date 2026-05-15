/**
 * Unit tests for outlineClient HTML parsing and auth detection.
 *
 * The most important test here is the JS-redirect regression:
 * outline.uwaterloo.ca returns a 200 page that redirects to OIDC via JavaScript
 * when the session cookie is invalid. This used to silently return empty arrays
 * (we were parsing the redirect HTML as if it were a real outline page).
 *
 * All tests mock global fetch — no network required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchCourseOutline,
  getCurrentTerm,
  buildOutlineUrl,
  OutlineAuthError,
} from '../../src/study/outlineClient.js';

// ─── Mock fetch helper ────────────────────────────────────────────────────────

// The new flow: 1) API search (returns JSON), 2) fetch view page (returns HTML)
// For most tests, we want the API search to succeed and test the HTML parsing.
const MOCK_SEARCH_RESULT = [{ term: '1265', courses: 'CS 138', title: 'Intro', url: '/viewer/view/abc123' }];

function mockFetch(status: number, html: string, location?: string) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
    // API search call
    if (url.includes('/viewer/api/search/')) {
      return {
        status: 200,
        ok: true,
        json: async () => MOCK_SEARCH_RESULT,
      };
    }
    // View page call
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: {
        get: (name: string) => {
          if (name.toLowerCase() === 'location') return location ?? null;
          return null;
        },
      },
      text: async () => html,
    };
  }));
}

// ─── HTML fixtures ────────────────────────────────────────────────────────────

const JS_REDIRECT_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<title id="redirect-parent" data-redirect-url="/oidc/DIYRYAS4/authorize_complete?client_id=DIYRYAS4">
Redirecting...</title>
</head><body></body></html>`;

const ASSESSMENT_TABLE_STANDARD = `<html><body>
<h1>CS 138 — Introduction to Data Abstraction and Implementation</h1>
<table>
  <thead><tr>
    <th>Component</th><th>Weight</th><th>Due Date</th>
  </tr></thead>
  <tbody>
    <tr><td>Assignment 1</td><td>5%</td><td>May 20</td></tr>
    <tr><td>Assignment 2</td><td>5%</td><td>Jun 3</td></tr>
    <tr><td>Midterm</td><td>25%</td><td>Jun 17</td></tr>
    <tr><td>Final Exam</td><td>40%</td><td>Aug 5</td></tr>
  </tbody>
</table>
</body></html>`;

const ASSESSMENT_TABLE_ALT_HEADERS = `<html><body>
<h1>ECE 222 — Digital Computers</h1>
<table>
  <thead><tr>
    <th>Evaluation</th><th>Worth</th><th>Due</th>
  </tr></thead>
  <tbody>
    <tr><td>Lab 1</td><td>10%</td><td>May 28</td></tr>
    <tr><td>Lab 2</td><td>10%</td><td>Jun 11</td></tr>
    <tr><td>Final</td><td>50%</td><td>Aug 10</td></tr>
  </tbody>
</table>
</body></html>`;

const SCHEDULE_TABLE = `<html><body>
<h1>CS 138</h1>
<table>
  <thead><tr>
    <th>Week</th><th>Topic</th><th>Readings</th>
  </tr></thead>
  <tbody>
    <tr><td>1</td><td>Introduction to Racket</td><td>Ch 1</td></tr>
    <tr><td>2</td><td>Recursive Data Structures</td><td>Ch 2-3</td></tr>
    <tr><td>3</td><td>Higher-order Functions</td><td>Ch 4</td></tr>
  </tbody>
</table>
</body></html>`;

const INSTRUCTOR_DL = `<html><body>
<h1>CS 138</h1>
<dl>
  <dt>Instructor</dt><dd>Dr. Alice Chen</dd>
  <dt>Email</dt><dd>alice.chen@uwaterloo.ca</dd>
  <dt>Office</dt><dd>DC 3142</dd>
  <dt>Office Hours</dt><dd>Tuesdays 2–4pm</dd>
</dl>
</body></html>`;

const INSTRUCTOR_TABLE = `<html><body>
<h1>MATH 137</h1>
<table>
  <thead><tr>
    <th>Instructor</th><th>Email</th><th>Office</th>
  </tr></thead>
  <tbody>
    <tr><td>Dr. Bob Nguyen</td><td>b.nguyen@uwaterloo.ca</td><td>MC 5417</td></tr>
  </tbody>
</table>
</body></html>`;

const LEARNING_OBJECTIVES = `<html><body>
<h1>CS 138</h1>
<h2>Learning Objectives</h2>
<ul>
  <li>Understand functional programming paradigms</li>
  <li>Apply recursion to solve problems</li>
  <li>Implement abstract data types</li>
</ul>
</body></html>`;

const EMPTY_HTML = `<html><body><h1>CS 138</h1></body></html>`;

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Auth detection ───────────────────────────────────────────────────────────

describe('fetchCourseOutline — auth error detection', () => {
  it('throws OutlineAuthError on 200 JS-redirect page pointing to /oidc/', async () => {
    mockFetch(200, JS_REDIRECT_HTML);
    await expect(
      fetchCourseOutline('sessionid=expired', 'CS138', '1265')
    ).rejects.toThrow(OutlineAuthError);
  });

  it('throws OutlineAuthError on 302 redirect to /oidc/login', async () => {
    mockFetch(302, '', '/oidc/login?next=/viewer/course/cs/138/1265/');
    await expect(
      fetchCourseOutline('sessionid=expired', 'CS138', '1265')
    ).rejects.toThrow(OutlineAuthError);
  });

  it('throws OutlineAuthError on 302 redirect to duosecurity', async () => {
    mockFetch(302, '', 'https://api-xxx.duosecurity.com/oauth/v1/authorize');
    await expect(
      fetchCourseOutline('sessionid=expired', 'CS138', '1265')
    ).rejects.toThrow(OutlineAuthError);
  });

  it('throws a plain Error (not OutlineAuthError) when API returns no results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/viewer/api/search/')) {
        return { status: 200, ok: true, json: async () => [] };
      }
      return { status: 404, ok: false, text: async () => 'Not Found', headers: { get: () => null } };
    }));
    await expect(
      fetchCourseOutline('sessionid=valid', 'CS999', '1265')
    ).rejects.toThrow(/No outline found/);
  });

  it('does NOT throw on a valid 200 HTML page (no redirect element)', async () => {
    mockFetch(200, EMPTY_HTML);
    await expect(
      fetchCourseOutline('sessionid=valid', 'CS138', '1265')
    ).resolves.toBeTruthy();
  });
});

// ─── Assessment parsing ───────────────────────────────────────────────────────

describe('fetchCourseOutline — assessment parsing', () => {
  it('parses Component/Weight/Due Date columns', async () => {
    mockFetch(200, ASSESSMENT_TABLE_STANDARD);
    const result = await fetchCourseOutline('sessionid=valid', 'CS138', '1265');
    expect(result.assessments).toHaveLength(4);
    expect(result.assessments[0]).toMatchObject({ name: 'Assignment 1', weight: '5%', date: 'May 20' });
    expect(result.assessments[2]).toMatchObject({ name: 'Midterm', weight: '25%' });
  });

  it('parses Evaluation/Worth/Due columns (alternative headers)', async () => {
    mockFetch(200, ASSESSMENT_TABLE_ALT_HEADERS);
    const result = await fetchCourseOutline('sessionid=valid', 'ECE222', '1265');
    expect(result.assessments).toHaveLength(3);
    expect(result.assessments[0]).toMatchObject({ name: 'Lab 1', weight: '10%' });
    expect(result.assessments[2]).toMatchObject({ name: 'Final', weight: '50%' });
  });

  it('returns empty assessments for HTML with no grade table', async () => {
    mockFetch(200, EMPTY_HTML);
    const result = await fetchCourseOutline('sessionid=valid', 'CS138', '1265');
    expect(result.assessments).toEqual([]);
  });

  it('does not include header row in assessments (skips "Component" row)', async () => {
    mockFetch(200, ASSESSMENT_TABLE_STANDARD);
    const result = await fetchCourseOutline('sessionid=valid', 'CS138', '1265');
    const names = result.assessments.map(a => a.name.toLowerCase());
    expect(names).not.toContain('component');
    expect(names).not.toContain('weight');
  });
});

// ─── Schedule parsing ─────────────────────────────────────────────────────────

describe('fetchCourseOutline — schedule parsing', () => {
  it('parses Week/Topic/Readings table', async () => {
    mockFetch(200, SCHEDULE_TABLE);
    const result = await fetchCourseOutline('sessionid=valid', 'CS138', '1265');
    expect(result.schedule).toHaveLength(3);
    expect(result.schedule[0]).toMatchObject({ topic: 'Introduction to Racket' });
    expect(result.schedule[1]).toMatchObject({ topic: 'Recursive Data Structures' });
  });

  it('returns empty schedule for HTML with no schedule table', async () => {
    mockFetch(200, EMPTY_HTML);
    const result = await fetchCourseOutline('sessionid=valid', 'CS138', '1265');
    expect(result.schedule).toEqual([]);
  });
});

// ─── Instructor parsing ───────────────────────────────────────────────────────

describe('fetchCourseOutline — instructor parsing', () => {
  it('parses instructor from definition list', async () => {
    mockFetch(200, INSTRUCTOR_DL);
    const result = await fetchCourseOutline('sessionid=valid', 'CS138', '1265');
    expect(result.instructors.length).toBeGreaterThanOrEqual(1);
    const instr = result.instructors[0];
    expect(instr.name).toContain('Alice Chen');
    expect(instr.email).toBe('alice.chen@uwaterloo.ca');
  });

  it('parses instructor from table (table-based fallback)', async () => {
    mockFetch(200, INSTRUCTOR_TABLE);
    const result = await fetchCourseOutline('sessionid=valid', 'MATH137', '1265');
    expect(result.instructors.length).toBeGreaterThanOrEqual(1);
    expect(result.instructors[0].name).toContain('Bob Nguyen');
    expect(result.instructors[0].email).toContain('uwaterloo.ca');
  });
});

// ─── Learning objectives ──────────────────────────────────────────────────────

describe('fetchCourseOutline — learning objectives', () => {
  it('parses list items after "Learning Objectives" heading', async () => {
    mockFetch(200, LEARNING_OBJECTIVES);
    const result = await fetchCourseOutline('sessionid=valid', 'CS138', '1265');
    expect(result.learningObjectives).toHaveLength(3);
    expect(result.learningObjectives[0]).toContain('functional programming');
  });
});

// ─── Metadata ─────────────────────────────────────────────────────────────────

describe('fetchCourseOutline — metadata', () => {
  it('upcases the courseCode in the result', async () => {
    mockFetch(200, EMPTY_HTML);
    const result = await fetchCourseOutline('sessionid=valid', 'cs138', '1265');
    expect(result.courseCode).toBe('CS138');
  });

  it('preserves the term in the result', async () => {
    mockFetch(200, EMPTY_HTML);
    const result = await fetchCourseOutline('sessionid=valid', 'CS138', '1265');
    expect(result.term).toBe('1265');
  });

  it('extracts the page title from h1', async () => {
    mockFetch(200, ASSESSMENT_TABLE_STANDARD);
    const result = await fetchCourseOutline('sessionid=valid', 'CS138', '1265');
    expect(result.title).toContain('CS 138');
  });

  it('rawHtml contains the fetched HTML', async () => {
    mockFetch(200, ASSESSMENT_TABLE_STANDARD);
    const result = await fetchCourseOutline('sessionid=valid', 'CS138', '1265');
    expect(result.rawHtml).toContain('Assignment 1');
  });
});

// ─── getCurrentTerm ───────────────────────────────────────────────────────────

describe('getCurrentTerm', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns Winter term (suffix 1) for January', () => {
    vi.setSystemTime(new Date('2026-01-15T00:00:00Z'));
    expect(getCurrentTerm()).toBe('1261');
  });

  it('returns Winter term (suffix 1) for April (last Winter month)', () => {
    vi.setSystemTime(new Date('2026-04-30T23:59:59Z'));
    expect(getCurrentTerm()).toBe('1261');
  });

  it('returns Spring term (suffix 5) for May', () => {
    vi.setSystemTime(new Date('2026-05-15T12:00:00Z')); // mid-month avoids timezone edge cases
    expect(getCurrentTerm()).toBe('1265');
  });

  it('returns Spring term (suffix 5) for August', () => {
    vi.setSystemTime(new Date('2026-08-15T12:00:00Z'));
    expect(getCurrentTerm()).toBe('1265');
  });

  it('returns Fall term (suffix 9) for September', () => {
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    expect(getCurrentTerm()).toBe('1269');
  });

  it('returns Fall term (suffix 9) for December', () => {
    vi.setSystemTime(new Date('2026-12-15T12:00:00Z'));
    expect(getCurrentTerm()).toBe('1269');
  });
});

// ─── buildOutlineUrl ──────────────────────────────────────────────────────────

describe('buildOutlineUrl', () => {
  it('builds correct URL for uppercase course code', () => {
    expect(buildOutlineUrl('CS138', '1265')).toBe(
      'https://outline.uwaterloo.ca/viewer/course/cs/138/1265/'
    );
  });

  it('handles mixed-case input', () => {
    expect(buildOutlineUrl('Cs138', '1265')).toBe(
      'https://outline.uwaterloo.ca/viewer/course/cs/138/1265/'
    );
  });

  it('handles multi-letter department codes', () => {
    expect(buildOutlineUrl('MATH137', '1261')).toBe(
      'https://outline.uwaterloo.ca/viewer/course/math/137/1261/'
    );
  });

  it('throws on malformed course code with no number', () => {
    expect(() => buildOutlineUrl('CS', '1265')).toThrow();
  });

  it('throws on completely invalid course code', () => {
    expect(() => buildOutlineUrl('12345', '1265')).toThrow();
  });
});
