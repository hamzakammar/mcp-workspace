# Horizon Launch Roadmap — May 6–11, 2026

**Goal:** Fully reliable, feature-complete MCP server ready for Summer term (May 12).  
**Available time:** ~3–4 hrs/night after Shopify.  
**Total budget:** ~18–24 hrs across 6 evenings.

---

## Dependency Map

```
D2L re-login reliability ──┬──► Notion connector (must be stable first)
                            └──► Priority / submission status

Crowdmark title fix ───────► already done, verify only

Outline parsing fix ───────► independent (Spring term courses need this)

EFS ───────────────────────► DEFER (S3 already handles browser state;
                                      EFS adds complexity for marginal gain)
```

**Critical path:** D2L reliability → everything else. If re-login is flaky, nothing else matters.

---

## Blockers to flag now

| # | Blocker | Impact | Mitigation |
|---|---------|--------|------------|
| B1 | Notion OAuth app needs to be created in Notion dev portal before coding starts | Blocks Notion connector entirely | Create the integration at notion.so/my-integrations on May 6 |
| B2 | outline.uwaterloo.ca HTML structure unknown — parser may need manual inspection | Blocks outline fix | Fetch a live outline page early in the session and inspect DOM |
| B3 | D2L `HasSubmission` field availability varies by D2L version | Blocks submission status | Check against live API on May 6 session |

---

## Day-by-Day Plan

### Tuesday May 6 — Reliability foundation (~3 hrs)

- [ ] **Verify D2L silent re-login end-to-end**
  - Manually expire a session and confirm `sessionRefresher` recovers it headlessly
  - Confirm no Duo push fires on a valid S3 ADFS state refresh
  - Fix any failures found

- [ ] **Add proactive Duo expiry notification** (currently only fires after failure)
  - In `sessionRefresher.ts`: if ADFS state age > 20 days, send push "Your D2L session will need re-authentication soon" before it actually fails
  - Threshold: warn at 20 days, S3 state TTL is 25 days

- [ ] **Check D2L submission status field**
  - Hit `/d2l/api/le/1.57/{orgUnitId}/dropbox/folders/{folderId}/submissions/mysubmissions/` live
  - Confirm whether `HasSubmission` or submission array is available
  - Note findings for May 7 implementation

- [ ] **Update `docs/debt.md`** — mark Crowdmark as implemented

---

### Wednesday May 7 — Bugs & submission status (~4 hrs)

- [ ] **Fix course outline HTML parser**
  - Fetch a live Spring 2026 outline page (e.g. CS 138) and inspect actual DOM
  - Update selectors in `outlineClient.ts` to match real structure
  - Re-fetch and cache outlines for all enrolled courses, verify assessments/schedule/instructors populate
  - _Spring term courses need this working by May 12_

- [ ] **Submission status in `what_should_i_work_on`**
  - In `priority.ts` + `priorityGlobal.ts`: if `HasSubmission=true` or submissions array non-empty, mark as submitted and sort to bottom of the list
  - Add `submitted: true` field to output so the LLM can communicate it clearly
  - If D2L field is unavailable (found on May 6), use due date in the past as proxy

- [ ] **Fix grade weighting fuzzy match**
  - Current three-tier string match misses "A1" vs "Assignment 1" style mismatches
  - Add a number-extraction fallback: if both names contain the same integer (e.g. "1"), treat as a match
  - Prevents weight=0.1 fallback for most real-world cases

---

### Thursday May 8 — Notion connector pt. 1 (~4 hrs)

- [ ] **Notion OAuth flow**
  - Add `connect_notion` tool to `connect.ts` — returns OAuth URL (similar to D2L connect)
  - Add `/api/notion/callback` route in `routes.ts` — exchanges code for access token, stores in `user_credentials` (service=`notion`)
  - Add Notion connect button to `onboard.html`

- [ ] **Notion data model**
  - Create or find the user's assignment tracking database (allow user to pass a DB ID, or create one)
  - Define properties: Course (select), Assignment (title), Due Date (date), Status (select: Not Started / In Progress / Submitted / Graded), Grade (number), Weight (number)

- [ ] **Pull D2L data for Notion sync**
  - Reuse existing `getMyEnrollments` + `getDropboxFolders` + `getGrades` pipeline
  - Map to Notion property schema

---

### Friday May 9 — Notion connector pt. 2 (~4 hrs)

- [ ] **Notion push logic**
  - Implement `syncToNotion(userId)` — upserts pages into the user's DB (match on course+assignment title to avoid duplicates)
  - Handle rate limiting (Notion API: 3 req/sec)
  - On conflict: update grade/status if changed, don't overwrite user edits to other fields

- [ ] **`sync_to_notion` MCP tool**
  - Description: _"Sync your D2L assignments, due dates, and grades into your Notion database. Run this after connecting Notion to populate it, and again after grades are released."_
  - Register in `index.ts`
  - Returns summary: X courses, Y assignments synced, Z updated

- [ ] **Deploy + smoke test Notion flow end-to-end**

---

### Saturday May 10 — Integration testing & polish (~4 hrs)

- [ ] **End-to-end test all tools** with a live session
  - `get_my_course_outlines` → assessments/schedule non-empty
  - `what_should_i_work_on_global` → submitted items deprioritized, weights correct
  - `get_crowdmark_assignments` → real titles (not UUIDs)
  - `sync_to_notion` → assignments appear in Notion DB
  - `get_cached_outline` → works with default term (1265)

- [ ] **Crowdmark auto-refresh smoke test**
  - Connect via VNC, wait 20 min, call `get_crowdmark_assignments` — should silently refresh

- [ ] **Fix any regressions found above**

- [ ] **Multi-school outline config** (if time allows)
  - `src/config/outlineHosts.ts` already exists — populate with any other known outline hosts
  - Estimated: 30 min

---

### Sunday May 11 — Launch prep (~3 hrs)

- [ ] **Final deploy with all changes**
- [ ] **Verify `sessionRefresher` proactive warning fires correctly** in staging
- [ ] **Update `docs/debt.md`** with any deferred items
- [ ] **Commit and tag release** `v2.0.0-summer`
- [ ] **Write brief onboarding note** for new users (what Horizon can do, how to connect)

---

## Priority Tiers

| Priority | Items | Why |
|----------|-------|-----|
| **Must ship** | D2L re-login reliability, proactive Duo warning, submission status, outline parsing | Core promise: "sign up once, never think about it again" |
| **Should ship** | Notion connector, grade weighting fix, Crowdmark title verification | Launch differentiators + data quality |
| **Nice to have** | Multi-school outline, discussion board tool, integration tests | Can slip to post-launch |
| **Defer** | EFS persistence | S3 already handles state; EFS is infra complexity for marginal gain |

---

## Time Budget

| Day | Task | Est. hrs |
|-----|------|----------|
| Tue May 6 | D2L re-login verify, proactive warning, submission field check | 3 |
| Wed May 7 | Outline parser fix, submission status, grade weighting | 4 |
| Thu May 8 | Notion OAuth + data model + D2L pipeline | 4 |
| Fri May 9 | Notion push + tool + deploy | 4 |
| Sat May 10 | E2E testing + polish + fixes | 4 |
| Sun May 11 | Final deploy + tag + docs | 3 |
| **Total** | | **22 hrs** |

Buffer: ~2 hrs. Notion connector is the biggest risk — if OAuth setup takes longer than expected, drop `sync_to_notion` from Sunday scope and ship as a post-launch follow-up.
