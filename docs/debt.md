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
