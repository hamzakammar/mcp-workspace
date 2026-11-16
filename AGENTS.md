# mcp-workspace — Agent Guide

> **Read this first.** This file is the authoritative entry point for any AI agent or engineer working in this repository. It tells you how the codebase is structured, where decisions live, and how to make progress without breaking things.

---

## 1. What is mcp-workspace?

mcp-workspace is a personal MCP (Model Context Protocol) server workspace that gives AI assistants (Claude, Copilot, Poke, etc.) access to university tools — specifically D2L Brightspace and Piazza. It is deployed on an EC2 instance and managed via PM2. The workspace may host multiple MCP servers, each running on its own port.

---

## 2. Repo Map (progressive disclosure)

| Path | Purpose |
|---|---|
| `d2l-mcp/` | D2L Brightspace + Piazza MCP server (primary MCP) |
| `d2l-mcp/tests/` | Test suite (vitest): unit tests in `tests/unit/`, live D2L tests in `*.integration.test.ts` (`npm run test:integration` from `d2l-mcp/`) |
| `supabase/` | Supabase migrations and edge functions |
| `study-mcp-app/` | Expo mobile app |
| `ecosystem.config.cjs` | PM2 process config for all MCPs |
| `package.json` | Workspace-level scripts (build-all, start-all, etc.) |
| `docs/` | Architecture, debt log, ADRs, and plans — **start here for context** |
| `AGENTS.md` | This file |

---

## 3. Key Conventions

- **TypeScript everywhere.** All new MCP tool files must be `.ts`. Build to `dist/` before deploying.
- **Each MCP gets its own directory and port.** Do not co-locate two MCP servers in the same directory. Add new MCPs as sibling directories alongside `d2l-mcp/`.
- **PM2 is the process manager.** All servers are defined in `ecosystem.config.cjs`. Do not start servers manually in production.
- **Sessions are managed locally and synced.** D2L and Piazza session files live in `~/.d2l-session/` and `~/.piazza-session/`. They must be synced to EC2 via `EC2_HOST=<host> npm run sync-sessions` after re-authentication.
- **Private mapping files are gitignored.** `notes_map.json` and `piazza_map.json` (in `d2l-mcp/src/study/db/`) are meant to stay out of git, but are currently tracked because they are statically imported by the build. Document their schema in `docs/architecture.md` if it changes.
- **No secrets in source.** Credentials and keys live in each MCP's `.env` (gitignored). Use environment variables only.

---

## 4. Before You Change Anything

1. Read `docs/architecture.md` — understand the current system shape and deployment topology.
2. Read `docs/debt.md` — know what is already broken or deferred.
3. Check `docs/decisions/` — look for an ADR that covers the area you're working in.
4. Check `docs/plans/` — see if there is an active plan for this feature.

---

## 5. How to Make a Change

1. **Small change (bug fix, config, dependency update):** Make it directly on `master` with a clear commit message.
2. **New MCP or significant feature:** Create a branch, open a PR, and reference any relevant ADR or plan.
3. **Architecture decision:** Write or update an ADR in `docs/decisions/` before or alongside the change.
4. **New technical debt:** Add an entry to `docs/debt.md` immediately — do not leave it undocumented.

---

## 6. Running the Project

```bash
# Install all dependencies
npm run install-all

# Build all MCPs
npm run build-all

# Start all MCPs via PM2
npm run start-all

# Check status
npm run status
```

For local D2L auth (required before session sync):
```bash
cd d2l-mcp
npm run build && npm run auth
```

For full setup and deployment instructions, see `README.md` and `DEPLOYMENT_CHECKLIST.md`.

---

## 7. Where Decisions Live

- **Why we chose X over Y:** `docs/decisions/ADR-NNNN-title.md`
- **What is broken or deferred:** `docs/debt.md`
- **What we are building next:** `docs/plans/`
- **System shape and deployment topology:** `docs/architecture.md`

---

*Keep this file current. If the repo changes shape — new MCPs added, deployment changes, new tools — update this map.*
