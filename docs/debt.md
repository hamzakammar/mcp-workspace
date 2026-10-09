# Technical Debt Log

> This file is the authoritative record of known technical debt in mcp-workspace.  
> **Rule:** If you knowingly defer something, add it here before merging. Do not leave debt undocumented.

---

## How to Use This File

Each entry follows this format:

```
### [DEBT-NNN] Short title
- **Severity:** low | medium | high | critical
- **Area:** component / module / system affected
- **Logged:** YYYY-MM-DD
- **Author:** name or handle
- **Description:** What is the problem and why does it exist?
- **Impact:** What breaks or degrades if this is not fixed?
- **Fix:** What would a correct resolution look like?
- **Unblocked by:** What needs to happen before this can be addressed? (optional)
```

Severity guide:
- **critical** — actively causing data loss, security issues, or production outages.
- **high** — causing user-facing bugs or significantly slowing development.
- **medium** — creates friction; should be fixed within the next 2–3 milestones.
- **low** — nice-to-have cleanup; address opportunistically.

---

## Open Debt

<!-- Add new entries below this line, newest first. -->

### [DEBT-012] Password-reset emails depend on Supabase default SMTP
- **Severity:** high
- **Area:** Supabase Auth (prod `qialmumlcezeqvyyhjlu`)
- **Logged:** 2026-10-09
- **Author:** agent
- **Description:** No custom SMTP is configured, so auth email uses Supabase's built-in sender (rate limit 2 emails/hour project-wide, intended for team members only). The redirect allowlist was also empty with Site URL `http://localhost:3000`, which sent every reset link to localhost (fix: dashboard URL Configuration — see architecture.md).
- **Impact:** Reset emails may not arrive for real users, or stop after 2/hour.
- **Fix:** Configure custom SMTP (e.g. Resend) in Auth → SMTP; raise the email rate limit.

### [DEBT-011] Gateway verifies every JWT with a round-trip to Supabase
- **Severity:** medium
- **Area:** `d2l-mcp/gateway/middleware/auth.go` (`Auth`, `verifyAccessToken`)
- **Logged:** 2026-10-09
- **Author:** agent
- **Description:** `Auth(_ string)` ignores the JWKS URL and calls `GET /auth/v1/user` on every request.
- **Impact:** Added latency on every call; a Supabase Auth blip 401s all JWT traffic.
- **Fix:** Verify locally against cached JWKS; fall back to introspection on key miss.

### [DEBT-010] D2L client: no pagination, no timeouts, server-wide host
- **Severity:** medium
- **Area:** `d2l-mcp/src/client.ts`
- **Logged:** 2026-10-09
- **Author:** agent
- **Description:** `myenrollments` (Bookmark) and calendar/quiz lists (Next) are not paged; `fetch` has no AbortSignal; the per-request client uses `D2L_HOST` rather than the user's stored host.
- **Impact:** Items past page 1 silently missing; a hung D2L call hangs the tool; non-UWaterloo users unsupported.
- **Fix:** Loop on paging tokens, `AbortSignal.timeout(15000)`, resolve host from the user's credential row.

### [DEBT-009] Piazza/notes sync use static server-wide course maps
- **Severity:** medium
- **Area:** `d2l-mcp/src/study/src/piazza.ts`, `notes.ts`, `db/piazza_map.json`, `db/notes_map.json`
- **Logged:** 2026-10-09
- **Author:** agent
- **Description:** Sync targets come from JSON maps baked into the build (last term's Piazza classes; empty notes map), shared by every user.
- **Impact:** Current-term Piazza never syncs; other users would sync the owner's classes.
- **Fix:** Derive classes per user from Piazza `network.get_user_classes` / user settings.

### [DEBT-008] `sync_all` only inserts tasks
- **Severity:** low
- **Area:** `d2l-mcp/src/study/src/sync.ts`
- **Logged:** 2026-10-09
- **Author:** agent
- **Description:** Due-date changes and submissions are never applied; `course_id` is the orgUnitId rather than a course code.
- **Impact:** Stale "open" tasks from past terms in `tasks_list`/`plan_week`.
- **Fix:** Upsert `due_at`/status and store the short course code; close tasks for ended terms.

### [DEBT-007] Credential hygiene in `user_credentials`
- **Severity:** medium
- **Area:** Supabase `public.user_credentials`, `d2l-mcp/src/study/outlineAuth.ts`
- **Logged:** 2026-10-09
- **Author:** agent
- **Description:** One D2L row still holds a non-KMS password; session tokens (D2L cookies, Outline sessionid, Crowdmark cookies, Notion token) and the outline S3 storage state are stored unencrypted.
- **Impact:** A DB or bucket leak exposes live sessions.
- **Fix:** Run `scripts/migrate-encrypt-passwords.ts`; KMS-envelope the token column and outline state like D2L state.

### [DEBT-006] Backend image / deploy safety
- **Severity:** low
- **Area:** `d2l-mcp/Dockerfile`, ECS service, ALB, security group
- **Logged:** 2026-10-09
- **Author:** agent
- **Description:** Image runs as root, ships both system and Playwright Chromium (`playwright install ... || true` masks failure; Playwright's glibc build can't run on Alpine anyway), ~790 MB. No container healthCheck, deployment circuit breaker off, mutable `:latest` tags. SG allows tcp/3000 from 0.0.0.0/0 (backend binds 127.0.0.1, so not reachable). ALB TLS policy `ELBSecurityPolicy-2016-08`.
- **Impact:** Bad deploys don't auto-roll-back; larger attack surface.
- **Fix:** Non-root user, single Chromium, healthCheck + circuit breaker, git-SHA tags, drop the :3000 rule, TLS 1.2+ policy.

### [DEBT-005] Expired OAuth tokens / access logs never purged
- **Severity:** low
- **Area:** Supabase `oauth_*` tables, `credential_access_log`
- **Logged:** 2026-10-09
- **Author:** agent
- **Description:** ~650 expired OAuth access/refresh tokens and 11k access-log rows with no retention.
- **Fix:** pg_cron job deleting expired tokens daily and log rows older than 90 days.

### [DEBT-004] Mobile app dependencies far behind
- **Severity:** low
- **Area:** `study-mcp-app/`
- **Logged:** 2026-10-09
- **Author:** agent
- **Description:** Expo 52 (latest 57), RN 0.76, React Navigation 6; `npm audit` reports 80 issues (mostly build tooling). Unused axios, dead components (`UploadNote.tsx` posts to a non-existent route), push registration never called.
- **Fix:** Expo SDK upgrade pass; remove dead code; wire `services/push.ts`.

### [DEBT-001] Token validation only on first process-session use, not on every restart-recovery
- **Severity:** low
- **Area:** `d2l-mcp/src/auth.ts` — `getToken()`
- **Logged:** 2026-04-20
- **Author:** agent
- **Description:** `validateTokenLive()` is called at most once per user per server process (tracked via `userValidatedInSession`). If the token expires *between two tool calls in the same process session* (e.g. the token was 13.9h old when validated but the process runs for hours), Horizon will hit a 403 on the next real API call and rely on `forceRefreshToken()` in `client.ts` to recover. This is acceptable but not proactive.
- **Impact:** Users may see a single 403-then-retry latency spike mid-session. Does not cause persistent failures.
- **Fix:** Add a periodic background revalidation (e.g. check every 2h if token was last validated > 1h ago) — similar to what `sessionRefresher.js` does for the token age check.
- **Unblocked by:** Nothing; low priority since the 403-retry path already handles it silently.

### [DEBT-003] Workspace-root vitest scaffolding is broken — module resolution fails
- **Severity:** low
- **Area:** `tests/unit/marshal.test.ts`, `tests/unit/tools.test.ts`, `vitest.config.ts`
- **Logged:** 2026-05-14
- **Author:** agent
- **Description:** The workspace-root vitest config and the scaffolding tests under `tests/unit/` import from `../d2l-mcp/src/.../*.js`. Vitest cannot resolve those paths to TS sources (no resolver alias) and the workspace root has no `node_modules` (vitest only installed inside `d2l-mcp/`). The d2l-mcp-local test suite under `d2l-mcp/tests/unit/` passes cleanly (177 tests). Workspace-root tests never ran successfully.
- **Impact:** `npm test` from the repo root fails immediately. CI that runs root-level vitest will produce false failures.
- **Fix:** Either (a) delete the workspace-root `tests/` scaffolding and let `d2l-mcp/tests/` be canonical, or (b) install vitest at root, add a `resolve.alias` mapping in `vitest.config.ts`, and fix the test imports to point at compiled `dist/` or aliased TS sources.
- **Unblocked by:** Nothing.

### [DEBT-002] `get_assignment_rubric` returns all course rubrics, not only rubrics attached to the specific assignment
- **Severity:** medium
- **Area:** `d2l-mcp/src/tools/rubric.ts`
- **Logged:** 2026-04-20
- **Author:** agent
- **Description:** The D2L rubrics API (`/rubrics/`) returns all rubrics in the course, not a filtered set tied to the specific folder/assignment. The tool returns all criteria from all rubrics, which may include rubrics for other assignments in the same course.
- **Impact:** Rubric output may be inaccurate / inflated for multi-rubric courses.
- **Fix:** Use the assignment-specific rubric association endpoint if available (`/dropbox/folders/{folderId}/rubrics/`), or filter by rubric ID if the dropbox folder response includes associated rubric IDs.
- **Unblocked by:** Confirming whether D2L exposes per-folder rubric associations via the API.

---

## Resolved Debt

<!-- Move entries here when fixed, and note the resolution. -->

*None yet.*
