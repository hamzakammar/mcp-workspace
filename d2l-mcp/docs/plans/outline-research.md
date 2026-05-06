# University Course Outline API Research

## Summary

Course outline (syllabus) systems at Canadian and US universities are almost universally behind institutional login walls. There is no cross-institutional public API for course outlines. `outline.uwaterloo.ca` is one of the few schools with a dedicated outline viewer, but it requires authenticated access. Extending the current integration to other schools requires either finding school-specific scraping targets (auth required) or leveraging PDF-based public course calendars as a fallback.

---

## outline.uwaterloo.ca — URL Structure and Auth

### URL Patterns

All URLs are under `https://outline.uwaterloo.ca/`.

| Pattern | Description |
|---------|-------------|
| `/viewer/org/uwaterloo/` | List of all outlines for the UWaterloo organization |
| `/viewer/course/{subject}/{number}/{term}/` | Single course outline |

Examples:
- `/viewer/course/cs/135/1251/` — CS 135, Winter 2025
- `/viewer/course/math/135/1259/` — MATH 135, Fall 2025
- `/viewer/course/se/350/1261/` — SE 350, Winter 2026

Subject is lowercase (e.g. `cs`, `math`, `se`, `ece`). Number is the catalog number (e.g. `135`, `350`). Term uses UWaterloo's YYMM format: `1251` = Winter 2025, `1255` = Spring 2025, `1259` = Fall 2025, `1261` = Winter 2026.

### Authentication

Every request to `outline.uwaterloo.ca` is intercepted by a Django middleware that checks for a valid session. Unauthenticated requests are redirected to:

```
/oidc/login/?next={original_path}
```

Which immediately redirects to Duo Security's hosted OIDC authorization endpoint:

```
https://sso-4ccc589b.sso.duosecurity.com/oidc/DIYRYAS4OVZ37VJVYNUI/authorize
  ?response_type=code
  &client_id=DIYRYAS4OVZ37VJVYNUI
  &redirect_uri=https://outline.uwaterloo.ca/oidc/duo/callback/
  &scope=openid+email+profile
```

The callback path `/oidc/duo/callback/` is how the site completes the OIDC code exchange and sets its Django session cookie. The site uses the **`mozilla-django-oidc`** library (inferred from the `/oidc/login/` and `/oidc/duo/callback/` path naming conventions, which are this library's defaults).

**Practical auth path**: The current `outlineClient.ts` correctly handles this by accepting a `cookieHeader` string. The user must log in manually in a browser and copy their `outline.uwaterloo.ca` session cookie (likely named `sessionid`, Django's default). The client detects 302 redirects to `oidc/login` or `duosecurity` as auth failures and throws `OutlineAuthError`.

### Software Stack

The site is Django-rendered HTML (server-side). The existing parser (in `outlineClient.ts`) targets HTML tables, `<dl>` definition lists, and headings — the correct approach. There is no JSON API surface exposed.

---

## UWaterloo Open Data API (v3)

UWaterloo operates a public Open Data API at `https://openapi.data.uwaterloo.ca/`. It requires an API key (free registration). The API provides course metadata but **does not include course outlines or syllabi**.

Available course-related endpoints (v2, since confirmed — v3 adds similar):
- `GET /courses/{subject}/{catalog_number}` — course description, units, prerequisites
- `GET /courses/{subject}/{catalog_number}/schedule` — section times, room, instructors
- `GET /courses/{subject}/{catalog_number}/prerequisites` — prerequisite tree
- `GET /courses/{subject}/{catalog_number}/examschedule` — final exam schedule

This is useful supplementary data (e.g. to look up a course's official description or section enrollment) but cannot replace the outline viewer for assessment weights, due dates, and weekly schedules.

---

## Other Canadian Universities — Findings

### McMaster University

McMaster uses D2L Brightspace (branded "Avenue to Learn" at `avenue.cmc.ca`). No dedicated outline viewer domain was found — `outline.mcmaster.ca` returns ECONNREFUSED. Course outlines appear to be distributed as PDFs through the LMS or department websites, not through a standardized viewer.

### University of Alberta

`coursecalendar.ualberta.ca` returns ECONNREFUSED. U Alberta uses D2L Brightspace (eClass). No public outline URL pattern found. Course descriptions are in the public calendar at `calendar.ualberta.ca` but outlines are not.

### University of British Columbia

`outline.ubc.ca` and `courseoutlines.arts.ubc.ca` both return ECONNREFUSED. UBC uses Canvas LMS. Course outlines are distributed as PDFs through Canvas or departmental pages, not a centralized viewer.

### University of Toronto

UofT uses Quercus (Canvas). No public outline viewer found. Course outlines are distributed through Quercus or department websites.

### University of Guelph

Guelph uses D2L Brightspace. The public academic calendar (`calendar.uoguelph.ca/undergraduate-calendar/`) provides course **descriptions** (title, units, prerequisites) accessible without authentication, following the URL pattern `/undergraduate-calendar/course-descriptions/{subject}/`. These are not outlines — they contain no assessment weights or schedules.

### University of Manitoba

`umanitoba.ca/registrar/course-outlines` returns 404. U Manitoba uses D2L Brightspace. No centralized public outline viewer found.

### Queen's University

`queensu.ca/registrar/course-outlines` returns 404. Queen's uses onQ (D2L Brightspace). No public outline viewer found.

---

## OpenSyllabus

**https://opensyllabus.org** is a research project that has collected 32.9 million syllabi from thousands of institutions. It provides:

- A search/analytics UI at `opensyllabus.org`
- An "Explorer" tool at `explore.opensyllabus.org` (returns ECONNREFUSED — may be down/renamed)
- **No public REST API** documented anywhere on the site

OpenSyllabus appears to be a research/analytics product, not a developer-accessible data source. Access to the underlying data likely requires a commercial or academic partnership.

---

## D2L Schools and Outline URL Patterns

All D2L Brightspace deployments share the same LMS infrastructure, but **course content including outlines is stored inside course shells**, not at predictable public URLs. There is no standardized path like `/d2l/outline/{course}` — instructors upload PDFs or post HTML pages wherever they choose within the course.

The D2L Brightspace REST API (`/d2l/api/le/`) can list course content items with appropriate auth, but this requires knowing the `orgUnitId` and the content module structure, which varies per instructor. Parsing outline content from D2L would require:
1. Finding the outline document in the course content tree (no fixed location)
2. Downloading and parsing a PDF (if PDF) or HTML page

This is feasible but significantly more complex than the `outline.uwaterloo.ca` approach.

---

## Recommendations for Extending the Outline Integration

### Priority 1 — Keep outline.uwaterloo.ca as the Primary Source

It is the most structured and reliable data source for UWaterloo students. The current implementation in `outlineClient.ts` is correct. No changes needed for UWaterloo support.

### Priority 2 — Add a Generic "PDF Outline" Fallback

Many schools distribute outlines as PDFs uploaded to the LMS. A practical extension would be to:
1. Accept a user-provided URL (paste from browser)
2. Fetch the PDF or HTML
3. Parse it with a PDF extraction library or pass raw text to an LLM for structured extraction

This generalizes across all schools without needing school-specific integrations.

### Priority 3 — Hardcode Patterns for Additional D2L Schools (If Needed)

If a specific school is targeted (e.g. McMaster), the approach would be:
1. Look up course outline URLs experimentally (they vary by course/instructor)
2. Use the D2L Brightspace `/d2l/api/le/{ver}/{orgUnitId}/content/toc/` endpoint to walk the content tree
3. Find nodes with titles like "Course Outline", "Syllabus", "Course Information"
4. Fetch and parse the linked document

This requires per-school configuration of the D2L domain and is only worth doing for a school with significant user volume.

### Priority 4 — UWaterloo Open Data API as Supplement

Add a call to `https://openapi.data.uwaterloo.ca/v3/Courses/{subject}/{catalog_number}` to supplement outline data with:
- Official course description
- Credit weight
- Prerequisite string

This requires a free API key and no session auth. It would enrich the `ParsedOutline` struct with data that is not always present in the outline HTML.

### Non-Viable Paths

- **OpenSyllabus**: No public API, research-only.
- **Generic D2L scraping**: Too variable per-school and per-instructor. Not scalable.
- **McMaster/UBC/UToronto outline viewers**: Do not exist as distinct systems.

---

## outline.uwaterloo.ca Auth Flow — Summary for Implementers

```
1. User visits outline.uwaterloo.ca in browser
2. Redirected to /oidc/login/?next=/
3. Redirected to Duo SSO (sso-4ccc589b.sso.duosecurity.com)
4. User completes Duo MFA
5. Redirected back to /oidc/duo/callback/ with ?code=...
6. Django sets session cookie (name: "sessionid")
7. Subsequent requests to /viewer/* succeed with Cookie: sessionid=...

Session lifetime: unknown, likely hours to days.
Auth failure signal: 302 redirect to /oidc/login/ on any page request.
```

The current `outlineClient.ts` handles step 7 and detects auth failure correctly. No changes to the auth handling are needed.
