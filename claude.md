# CLAUDE.md — Horizon Autonomous Agent Guide

> You are an autonomous development agent working on Horizon (mcp-workspace). This file is your single source of truth. Read it fully before doing anything.

---

## Who You Are & What You're Doing

You are building Horizon — a multi-tenant MCP server that gives students AI-powered access to their D2L Brightspace LMS. The repo lives at `~/mcp-workspace`. The primary MCP server is in `d2l-mcp/`. It is deployed on EC2 and managed via PM2.

Your job is to work through the task list in Section 6 **one task at a time**, with a strict loop:

```
implement → test → fix until passing → deploy → log → next task
```

Do not skip steps. Do not move to the next task until the current one is tested, passing, and deployed.

---

## 2. Repo Map

| Path | Purpose |
|------|---------|
| `d2l-mcp/src/tools/` | All MCP tool implementations — this is where you add new tools |
| `d2l-mcp/src/index.ts` | MCP server entry point — register new tools here |
| `d2l-mcp/src/client.ts` | D2L API client — add new API calls here |
| `d2l-mcp/src/auth.ts` | D2L authentication and session management |
| `tests/` | Vitest test suite |
| `ecosystem.config.cjs` | PM2 config — controls what runs in production |
| `docs/architecture.md` | System shape and deployment topology |
| `docs/debt.md` | Known issues and deferred work |
| `docs/plans/` | Feature plans |
| `BUILD_LOG.md` | **Your running log** — append to this after every task |

---

## 3. Key Conventions

- **TypeScript everywhere.** All new tool files must be `.ts`. Always run `npm run build-all` before deploying.
- **Test before deploying.** Never deploy untested code.
- **PM2 is the process manager.** Restart with `npm run start-all` or `pm2 restart all` — never start servers manually.
- **Sessions live in `~/.d2l-session/`.** Do not touch auth logic unless the task explicitly requires it.
- **No secrets in source.** All credentials are in `.env` (gitignored). Read them via `process.env`.
- **Log everything.** Append a structured entry to `BUILD_LOG.md` after every task — what you built, what tests passed, what you deployed, any issues found.

---

## 4. How to Add a New Tool

1. Create `d2l-mcp/src/tools/<toolname>.ts`
2. Implement the tool function using the D2L client in `client.ts`
3. Register the tool in `d2l-mcp/src/index.ts`
4. Write an integration test in `tests/<toolname>.integration.test.ts`
5. Run the test: `npm run test:integration -- <toolname>`
6. Fix any failures before proceeding
7. Build: `npm run build-all`
8. Deploy: `npm run start-all` (or `pm2 restart d2l-mcp`)
9. Do a live smoke test via the MCP endpoint
10. Log to `BUILD_LOG.md`

---

## 5. Testing Protocol

### Unit tests
```bash
npm test
```

### Integration tests (hit real D2L endpoints)
```bash
npm run test:integration
```

Integration tests require a valid session in `~/.d2l-session/`. If auth fails, run `cd d2l-mcp && npm run auth-d2l` first.

### Smoke test after deploy
After deploying, verify the tool is registered and responding:
```bash
curl -s -X POST https://horizon.hamzaammar.ca/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: $HORIZON_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | jq '.result.tools[].name'
```

Confirm the new tool appears in the list. Then call it directly:
```bash
curl -s -X POST https://horizon.hamzaammar.ca/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: $HORIZON_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<tool_name>","arguments":{"orgUnitId":"<test_course_id>"}}}' \
  | jq '.result'
```

A valid response (even empty array) = pass. An error or missing tool = fail, fix before moving on.

---

## 6. Task List

Work through these **in order**. Do not skip. Do not parallelize.

### Task 1 — Token Persistence Fix
**Goal:** D2L session tokens must survive PM2 restarts and EC2 reboots.

**Context:** Currently sessions are stored in `~/.d2l-session/`. The suspected issue is that something in the auth flow regenerates tokens unnecessarily, or the session file isn't being read correctly on restart. When a user re-logs in, D2L accepts the existing session — suggesting the token is still valid but Horizon isn't finding it.

**Steps:**
1. Read `d2l-mcp/src/auth.ts` fully
2. Trace what happens on server startup — does it check for an existing session file before re-authenticating?
3. Add explicit startup logic: if `~/.d2l-session/` contains a valid token, use it. Do not re-auth.
4. Add a token validation check (hit a lightweight D2L endpoint to verify the token is still live)
5. Only trigger re-auth if the token is actually expired
6. Write a test that mocks a server restart and verifies the session is reused
7. Document the fix in `docs/debt.md`

---

### Task 2 — `get_quizzes` Tool
**Goal:** Fetch all quizzes for a course including name, due date, time limit, attempts allowed, and attempts used by the current user.

**D2L API endpoints:**
- `GET /d2l/api/le/1.67/{orgUnitId}/quizzes/` — list all quizzes
- `GET /d2l/api/le/1.67/{orgUnitId}/quizzes/{quizId}` — quiz details (attempts allowed, time limit)
- `GET /d2l/api/le/1.67/{orgUnitId}/quizzes/{quizId}/attempts/` — user's attempt history

**Note:** Question-level data is NOT available via API. Do not attempt to fetch it. Stick to metadata only.

**Tool schema:**
```typescript
// Input
{ orgUnitId: string }

// Output (array of)
{
  quizId: string
  name: string
  dueDate: string | null
  timeLimitMinutes: number | null
  attemptsAllowed: number | null  // null = unlimited
  attemptsUsed: number
  lastAttemptScore: number | null
}
```

**Test:** Call the tool against orgUnitId `1221444` (ECE 124). Verify the response is an array. Verify each item has at least `name` and `quizId`. A valid empty array is acceptable if no quizzes exist.

---

### Task 3 — `get_announcements` Tool
**Goal:** Fetch course announcements/news items from instructors.

**Note:** Check if this already exists in `d2l-mcp/src/tools/news.ts`. If it does, verify it works correctly and is properly registered. If it's broken or missing, implement it.

**D2L API endpoint:**
- `GET /d2l/api/le/1.67/{orgUnitId}/news/` — list announcements

**Tool schema:**
```typescript
// Input
{ orgUnitId: string, since?: string } // since = ISO date string

// Output (array of)
{
  id: string
  title: string
  body: string
  startDate: string
  isRead: boolean
}
```

**Test:** Call against orgUnitId `1221444`. Verify response shape.

---

### Task 4 — `get_assignment_rubric` Tool
**Goal:** Given an assignment, return a structured breakdown of what's being asked and the rubric criteria. This is tutoring context, NOT submission drafting.

**D2L API endpoints:**
- `GET /d2l/api/le/1.67/{orgUnitId}/dropbox/folders/{folderId}` — assignment details including description
- `GET /d2l/api/le/1.67/{orgUnitId}/rubrics/` — rubrics associated with the course

**Tool schema:**
```typescript
// Input
{ orgUnitId: string, folderId: string }

// Output
{
  name: string
  instructions: string
  dueDate: string | null
  totalPoints: number | null
  rubricCriteria: Array<{
    name: string
    description: string
    maxPoints: number
  }>
}
```

**Test:** Call against a known assignment in orgUnitId `1221444`. Verify name and instructions are populated.

---

### Task 5 — `what_should_i_work_on` Tool
**Goal:** The flagship intelligence tool. Synthesizes deadlines, grades, quiz attempts, and assignment weights into a prioritized recommendation.

**Logic:**
1. Fetch all assignments with due dates and weights
2. Fetch all quizzes with due dates, attempts allowed vs used
3. Fetch grades to identify weak areas
4. Sort by: (urgency = time until due) × (weight) × (not yet started penalty)
5. Return top 3-5 prioritized items with reasoning

**Tool schema:**
```typescript
// Input
{ orgUnitId: string, hoursAhead?: number } // hoursAhead defaults to 72

// Output
{
  recommendations: Array<{
    type: "assignment" | "quiz" | "review"
    name: string
    dueIn: string // human readable e.g. "6 hours"
    weight: number | null
    reason: string // e.g. "Worth 15%, due in 6 hours, 0 of 2 attempts used"
    urgencyScore: number
  }>
  summary: string // one sentence overview
}
```

**Note:** Do NOT call `get_my_grades` in this tool. Derive priority from due dates and weights only. Grades are hidden during demos per product spec.

**Test:** Call against orgUnitId `1221444`. Verify recommendations array is populated and each item has a reason field.

---

### Task 6 — Contextual Urgency Surfacing
**Goal:** Whenever any tool is called, proactively append upcoming urgent items to the response if anything is due within 48 hours.

**Implementation:** Add a middleware layer or response wrapper in `d2l-mcp/src/index.ts` that:
1. After any tool call completes, checks for items due within 48 hours
2. If any exist, appends a `_urgentReminders` field to the response
3. Caches the deadline check for 15 minutes to avoid hammering D2L on every call

**Test:** Call `get_course_content` on orgUnitId `1221444`. Verify `_urgentReminders` appears in the response (may be empty array if nothing due).

---

## 7. Deployment

After every task that passes tests:

```bash
# Build
npm run build-all

# Restart via PM2
pm2 restart d2l-mcp

# Verify it's running
pm2 status

# Smoke test
curl -s -X POST https://horizon.hamzaammar.ca/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: $HORIZON_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | jq '.result.tools | length'
```

The tool count should increase after each new tool is added.

---

## 8. BUILD_LOG.md Format

Append this structure after every completed task:

```markdown
## Task N — <Task Name>
**Date:** <ISO timestamp>
**Status:** ✅ Done / ❌ Failed / ⚠️ Partial

### What was built
<brief description>

### Tests run
- [ ] Unit tests: pass/fail
- [ ] Integration tests: pass/fail  
- [ ] Smoke test: pass/fail

### Deployed
Yes / No — <reason if no>

### Issues found
<any bugs, edge cases, or debt items discovered>

### Next task
<name of next task>
```

---

## 9. What NOT to Do

- Do not modify `auth.ts` unless working on Task 1
- Do not touch `.env` files or commit secrets
- Do not refactor working code that isn't in the task list
- Do not implement submission functionality — this violates academic integrity policy
- Do not fetch or expose grades in the `what_should_i_work_on` tool
- Do not deploy without running tests first
- Do not move to the next task if the current task's smoke test fails

---

## 10. If You Get Stuck

1. Check `docs/debt.md` — it may already be documented
2. Check `docs/architecture.md` for system context
3. Try the D2L API directly with curl before assuming the endpoint doesn't work
4. If a D2L endpoint returns 403, it likely needs a different permission scope — check `https://docs.valence.desire2learn.com/http-scopestable.html`
5. Log the blocker in `BUILD_LOG.md` and move to the next task if truly blocked

---

*This file is the authoritative agent guide. Do not modify it unless the architecture changes.*