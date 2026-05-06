# Crowdmark API Research

## Summary

Crowdmark (https://app.crowdmark.com) is a commercial online grading platform used by universities including UWaterloo. Despite having no public developer documentation, it does expose a REST API used internally by the web app. The API is divided into two distinct tiers: an **instructor/admin tier** authenticated via API key, and a **student tier** authenticated via browser session cookies.

---

## Official Documentation

Crowdmark publishes **no public API documentation**. The main site (crowdmark.com) has no developer portal, no API reference, and no integration guide. The subdomains `api.crowdmark.com`, `developers.crowdmark.com`, and `docs.crowdmark.com` all return ECONNREFUSED (not even a 404 — they do not exist).

The help site (crowdmark.com/help) is a WordPress/Elementor site with no technical content. There is no mention of webhooks, SDKs, or external integration guides anywhere on the public site.

---

## Authentication Mechanisms

### Instructor/Admin API — API Key

The instructor-facing API (the older `/api/` namespace) uses a query-parameter API key:

```
https://app.crowdmark.com/api/courses?api_key=YOUR_API_KEY
```

The API key appears to be issued to instructors or institutions, not students. This was discovered via the `waterloobae/CrowdmarkDashboard` PHP package on GitHub, which documents a rate limit of **10 requests per second** enforced by Crowdmark's backend.

### Student API — Browser Session (Cookie-Based)

The student-facing API (the `/api/v1/student/` and `/api/v2/student/` namespaces) uses browser session authentication via the `credentials: "include"` fetch mode. There is no API key — requests must carry the browser's session cookies established after logging in through Crowdmark's standard login flow (institution SSO or email/password).

This was confirmed by the `motiwalam/crowdmark-userscript` project, which runs inside the authenticated browser context at `app.crowdmark.com/student/*`.

---

## Discovered API Endpoints

### Instructor / Admin Tier (API Key Auth)
Base: `https://app.crowdmark.com/`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `api/courses?api_key=KEY` | List all courses |
| GET | `api/courses/{course_id}?api_key=KEY` | Get one course |
| GET | `api/courses/{course_id}/assessments?api_key=KEY` | List assessments for a course |
| GET | `api/assessments/{assessment_id}?api_key=KEY` | Get one assessment |
| GET | `api/assessments/{assessment_id}/questions?api_key=KEY` | List questions |
| GET | `api/assessments/{assessment_id}/booklets?api_key=KEY` | List booklets (paged) |
| GET | `api/booklets/{booklet_id}?api_key=KEY` | Get one booklet |
| GET | `api/booklets/{booklet_id}/responses?api_key=KEY` | Get responses for a booklet |
| GET | `api/booklets/{booklet_id}/pages?api_key=KEY` | Get pages for a booklet |
| GET | `api/questions/{question_id}/responses?api_key=KEY` | Get responses for a question |
| GET | `api/enrollments/{enrollment_id}?api_key=KEY` | Get an enrollment record |

Response format is JSON. Pagination is used for booklet lists; the PHP client batches 10 requests in parallel with multi-curl.

Source: `waterloobae/CrowdmarkDashboard` (PHP Composer package)

### Student Tier (Session Cookie Auth)
Base: `https://app.crowdmark.com/`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `api/v2/student/assignments?fields[exam-masters][]=type&fields[exam-masters][]=title` | List all student assignments |
| GET | `api/v1/student/results/{assignment_id}` | Get graded result for one assignment |
| GET | `api/v2/student/courses?page[number]={n}` | List enrolled courses (paged) |
| GET | `api/v2/student/courses/{course_id}/statistics` | Get per-course grade statistics |

The `v1/student/results/{id}` response is a JSON:API document that includes:
- `exam-masters` (assignment metadata, total points, class results array)
- `exam-questions` (per-question scores)
- `exam-master-questions` (question labels and point values)
- `annotations` (TA feedback attached to questions)
- `courses` (course name)

The shareable score link format is: `https://app.crowdmark.com/score/{uuid}`

Source: `motiwalam/crowdmark-userscript` (Tampermonkey/Violentmonkey script)

---

## Existing GitHub Integrations

| Repo | Language | What it does | Auth method |
|------|----------|--------------|-------------|
| `waterloobae/CrowdmarkDashboard` | PHP | Instructor dashboard: grade stats, CSV exports, booklet downloads | API key |
| `motiwalam/crowdmark-userscript` | JavaScript | Student: grade summary, class stats, score unlock | Browser session |
| `embeddedt/crowdmark-tweaks` | JavaScript (userscript) | Instructor: grading keybinds, booklet prefetching | Browser session |
| `kshvmdn/crowdmark` | JavaScript (CLI) | Student: download test pages from a score URL | Public score page (no auth) |
| `curtischong/crowdmark-downloader` | Python | Student: download all assessments as HTML with TA annotations | Selenium browser automation |
| `chenjie/crowdmark-dl` | Unknown | Download assignments/exam papers | Unknown |

---

## Key Findings

1. **The API exists but is undocumented.** All knowledge about it comes from reverse engineering by community developers.

2. **Two separate auth systems.** Instructor API uses API keys; student API uses session cookies from the browser. There is no OAuth flow, no token exchange endpoint, and no documented way for a third-party app to request access on behalf of a student.

3. **Student API key does not exist.** Students cannot obtain an API key. The only way to call student endpoints programmatically is to extract and reuse the session cookie from a logged-in browser session.

4. **Session cookies can be extracted** from a browser's DevTools (Application tab > Cookies > app.crowdmark.com). The relevant cookies are likely `_crowdmark_session` or similar. These expire with the session.

5. **The `/score/{uuid}` endpoint is semi-public.** Pages at `https://app.crowdmark.com/score/{uuid}` show a student's graded exam and appear accessible without authentication (by design — they are shareable links). This is useful for read-only access to already-graded work.

---

## Verdict: Viable Integration Path?

**Partially viable, with caveats.**

For the Horizon study assistant, the most practical integration path is:

- **Student grade/result data**: Use the session-cookie approach against `api/v1/student/results/` and `api/v2/student/courses/`. The user provides their Crowdmark session cookie (same pattern already used for outline.uwaterloo.ca and D2L). This is technically workable.
- **Score/feedback scraping**: The `/score/{uuid}` pages are semi-public and could be scraped for annotation/feedback text without any auth.
- **Fragility risk**: Crowdmark's API is fully internal with no stability guarantee. Endpoints or response shapes may change without notice. The `motiwalam/crowdmark-userscript` notes that the "score unlocker" feature was already patched by Crowdmark once.
- **Terms of Service**: Using undocumented internal APIs may violate Crowdmark's ToS. This should be reviewed before shipping.

**Recommended approach**: Add Crowdmark as an optional, user-enabled integration. User provides their session cookie. Fetch `api/v2/student/courses` and `api/v1/student/results/{id}` to pull grades and assignment feedback. Treat it as a best-effort integration that may break.
