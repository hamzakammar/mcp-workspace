# Build Log

---

## 2026-04-30 — Onboarding UX + Optional Integrations (connectTools)

**Goal:** Make all optional integrations (Piazza, Crowdmark, Course Outlines) connectable both from the dashboard UI and directly through Claude/MCP conversation. Registry-driven design so adding a new integration requires minimal code.

### Changes

**`src/tools/connect.ts`** (new)
- `connect_crowdmark` — validates `_crowdmark_session` cookie against app.crowdmark.com, stores in Supabase
- `connect_outline` — validates Django `sessionid` against outline.uwaterloo.ca, stores JSON `{ sessionid }` in Supabase
- `connect_piazza` — encrypts password via KMS, logs credential access, stores in Supabase
- `get_connection_guide` — returns step-by-step instructions for all services (MCP path + dashboard path)

**`src/index.ts`**
- Added `connectTools` import
- Registered all 4 connect tools: `connect_crowdmark`, `connect_outline`, `connect_piazza`, `get_connection_guide`

**`src/api/routes.ts`**
- `GET /api/crowdmark/status` — checks Supabase for crowdmark token
- `GET /api/outline/status` — checks Supabase for outline token
- `POST /api/crowdmark/connect` — validates + stores `_crowdmark_session`
- `POST /api/outline/connect` — validates + stores `sessionid`

**`src/public/onboard.html`** (dashboard redesign)
- Added **Crowdmark** and **Course Outlines** status rows to the Connections section
- Each row: status dot, description, Connect/Reconnect button
- Inline connect panels with cookie-paste UI (no page navigation required)
- `loadConnectionStatus()` now checks all 4 services
- `submitCrowdmarkConnect()` / `submitOutlineConnect()` handlers

**Build:** `npm run build` — clean (0 errors)
**Deploy:** `bash scripts/deploy-to-ecs.sh` — image pushed, ECS service force-redeployed
**Smoke test:** `GET /health` → `{"ok":true}` ✓

---

## Prior builds (Tasks 1–12)

Tasks 1–12 were completed in a prior session. Summary:
- Task 1: Grade weight scoring fix (use `GradeObject.Weight` %)
- Task 2: `Promise.allSettled` + CONCURRENCY=4 in priorityGlobal.ts
- Task 3: Rubric filtering by assignment-level rubric IDs
- Task 4: sessionRefresher log "threshold: 12h" fix
- Task 5: Skip submitted assignments in priority tools
- Task 6: Skip `_urgentReminders` injection for non-JSON tool responses
- Task 7: Replace empty `catch {}` in files.ts with error logging
- Task 8: Create `docs/debt.md` and `docs/plans/roadmap.md`
- Task 9: Crowdmark integration (crowdmarkClient.ts, tools/crowdmark.ts)
- Task 10: Outline integration (outlineHosts.ts registry, UW-only with clear error)
- Task 11: Discussion boards tool (`get_discussion_boards`)
- Task 12: Horizon status tool (`get_horizon_status`)
