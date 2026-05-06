# Horizon Roadmap

---

## Phase 1 — Core Tools (Done)

Shipped in the first build sprint (2026-04):

- D2L authentication: headless 3-tier fallback (API ping → ADFS browser state → credential login)
- Assignment tools: `get_assignments`, `get_assignment`, `get_assignment_submissions`
- Content tools: `get_course_content`, `get_course_topic`, `get_course_modules`, `get_course_module`
- Grade tools: `get_my_grades`
- Calendar: `get_upcoming_due_dates`
- Announcements: `get_announcements`
- Enrollment: `get_my_courses`
- File tools: `download_file`, `read_file`, `delete_file`
- Quiz tools: `get_quizzes`
- Rubric tool: `get_assignment_rubric`
- Priority tools: `what_should_i_work_on`, `what_should_i_work_on_global`
- Piazza tools: question search, post lookup, follow-up threads
- Study tools: notes sync, planning, semantic search
- Outline tools: `get_course_outline`, `get_my_course_outlines` (UW only)
- Security hardening: KMS encryption, audit logging, S3 TTLs, auth tightening, real data deletion

---

## Phase 2 — Bug Fixes & Integrations (Current)

In-progress as of 2026-04-30:

- Fix urgency scoring to use grade percentage weight instead of raw points (Tasks 1)
- Fix parallel D2L requests — concurrency-limited to 4 courses at a time (Task 2)
- Fix rubric tool to filter by assignment-level rubric associations where available (Task 3)
- Fix session refresher log mismatch (Task 4)
- Add submission status to priority tools — skip already-submitted assignments (Task 5)
- Fix `_urgentReminders` injection for non-JSON tool responses (Task 6)
- Fix silent error catch in files.ts (Task 7)
- Add onboarding status tool: `get_horizon_status` (Task 12)
- Crowdmark integration: research in progress — see `docs/plans/crowdmark-research.md`
- Outline integration for non-UW schools: research in progress — see `docs/plans/outline-research.md`

---

## Phase 3 — Expansion (Upcoming)

Planned but not yet scheduled:

- **Discussion boards**: D2L native discussion API (`/d2l/api/le/1.57/{orgUnitId}/discussions/forums/`) — covers schools that don't use Piazza
- **Grade weighting accuracy**: Replace fuzzy name matching with `AssociatedItemId` if D2L exposes it; reduce reliance on string comparison
- **Multi-school expansion**: Extend outline integration to McMaster, Manitoba, and other D2L schools; add school-to-outline-URL config map
- **Crowdmark integration**: If a viable API path is found (cookie-based session scraping or official API)
- **Integration test suite**: Set up a sandboxed D2L test environment so integration tests can run in CI without expired sessions
- **Forced S3 state migration**: Script to re-encrypt legacy unencrypted browser states in S3 without waiting for user re-auth
- **Grade trend analysis**: Use `get_my_grades` history to surface grade trajectory and predict final grade
