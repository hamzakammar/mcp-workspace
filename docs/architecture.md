# Architecture

> Last updated: 2026-10-09  
> ⚠️ Production no longer runs on EC2/PM2 — see "Production (current)" below. Older sections are kept for local/dev context.
> Status: living document — update whenever the system shape changes.

---

## Overview

mcp-workspace is a monorepo for personal MCP (Model Context Protocol) servers. Each MCP server is a standalone Node.js/TypeScript process that exposes tools over HTTP (or stdio). Servers are managed via PM2 and deployed on an AWS EC2 instance. AI clients (Poke, Claude Desktop, VS Code Copilot) connect to the servers remotely.

```
┌──────────────────────────────────────────┐
│            AI Clients                    │
│  Poke │ Claude Desktop │ VS Code Copilot │
└────────────────┬─────────────────────────┘
                 │ HTTP (MCP protocol)
┌────────────────▼─────────────────────────┐
│            AWS EC2 Instance              │
│  PM2 process manager                     │
│  ├── mcp-d2l  (port 3000)               │
│  └── [future MCPs] (port 3001+)          │
└────────────────┬─────────────────────────┘
                 │
┌────────────────▼─────────────────────────┐
│         External Services                │
│  D2L Brightspace │ Piazza │ Supabase     │
│  OpenAI Embeddings API                   │
└──────────────────────────────────────────┘
```

---

## Production (current, 2026-10)

- **Host:** AWS ECS Fargate, cluster `study-mcp-cluster`, service `study-mcp-backend`, one task (1 vCPU / 2 GB), us-east-1. Deployed with `d2l-mcp/scripts/deploy-to-ecs.sh` (`task-definition.json`).
- **Containers in the task:** `gateway` (Go, :8080 — auth, rate limit, CORS, metrics, reverse proxy) → `backend` (Node, 127.0.0.1:3000 — MCP + REST + VNC login sessions).
- **Ingress:** `study-mcp-alb` :443 → gateway :8080 (`https://horizon.hamzaammar.ca`). ALB idle timeout is 60s; long-lived VNC WebSockets rely on `websockify --heartbeat`.
- **Supabase:** prod project `qialmumlcezeqvyyhjlu` (auth + Postgres/pgvector). The other "StudyMCP" project (`ibtfezssuddmfwowiutv`) is what the local `.env` points at — it is not prod. Migrations: `supabase/migrations/` (recorded via `supabase migration list`); `d2l-mcp/src/study/db/migrations/` are historical, hand-applied files.
- **Auth email redirects:** Supabase Auth → URL Configuration must have Site URL `https://horizon.hamzaammar.ca/onboard` and `https://horizon.hamzaammar.ca/**` in Redirect URLs, or password-reset links fall back to the Site URL.

### VNC login flow (D2L / Outline / Crowdmark)
`POST /auth/{d2l,outline,crowdmark}/start` → `BrowserSessionManager` starts Xvfb + Chromium + x11vnc (localhost) + websockify on pooled display/ports and returns
`/vnc/assets/vnc.html?...&path=vnc/<sessionId>/websockify`. The noVNC client is served statically by Express from `/usr/share/novnc`; the gateway tunnels only
`/vnc/<uuid>/websockify` upgrades to Node, which proxies live sessions to their websockify port. Status is polled at `/auth/*/status/<sessionId>` (public; the UUID is the secret).
Ports/displays return to the pool only after the processes exit, and closed sessions are never proxied.

---

## Workspace Structure

### `d2l-mcp/` — Primary MCP Server
The D2L + Piazza MCP server. Built with TypeScript, compiled to `dist/`. Entry point: `src/index.ts`.

Internal structure:
```
src/
├── index.ts          # MCP server entry point, tool registration
├── auth.ts           # D2L session authentication
├── client.ts         # D2L API HTTP client
├── tools/            # Individual tool implementations
│   ├── calendar.ts
│   ├── content.ts
│   ├── grades.ts
│   ├── news.ts
│   └── piazza.ts
└── study/            # Study tools (tasks, notes, weekly planning)
    ├── piazzaAuth.ts
    ├── db/
    │   ├── schema.sql
    │   ├── notes_map.json     # GITIGNORED — maps course IDs to note PDF paths
    │   └── piazza_map.json    # GITIGNORED — maps course IDs to Piazza class nids
    └── src/
        ├── notes.ts
        ├── piazza.ts
        ├── planning.ts
        └── sync.ts
```

### `ecosystem.config.cjs` — PM2 Config
Defines all MCP processes: name, script path, environment variables, restart policy. This is the canonical list of what runs in production.

### `tests/` — Test Suite
Vitest-based unit and integration tests. Config in `vitest.config.ts` (unit) and `vitest.integration.config.ts` (integration; requires live credentials).

---

## Deployment Topology

- **EC2 Instance:** `ec2-user@3.93.185.101` — runs all MCP servers via PM2.
- **Local machine:** Used for D2L/Piazza 2FA authentication only. Session files are synced to EC2 after auth.
- **Session files:** `~/.d2l-session/` and `~/.piazza-session/` — expire ~24 hours. Must be re-synced after expiry.
- **Ports:** D2L MCP on 3000. Future MCPs increment from 3001.

---

## Data Flow — D2L Tool Call

```
AI client  →  MCP server (d2l-mcp)  →  auth.ts (session check/refresh)
                                      →  client.ts (HTTP call to D2L)
                                      →  tool response returned to client
```

## Data Flow — Piazza Semantic Search

```
AI client  →  piazza_semantic_search tool
           →  Supabase (pgvector similarity query)
           ←  ranked results returned
```

---

## External Services

| Service | Purpose | Notes |
|---|---|---|
| D2L Brightspace | LMS data source | Session-based auth, tokens expire ~1h |
| Piazza | Discussion forum data | Session-based auth, persisted locally |
| Supabase | Vector DB for semantic search + task storage | Schema in `d2l-mcp/src/study/db/schema.sql` |
| OpenAI API | Embeddings for semantic search | Key in `.env` |
| AWS EC2 | Hosting for all MCP servers | Managed via PM2 |

---

## Private Mapping Files

Two files are gitignored and must be created manually on each machine:

- `d2l-mcp/src/study/db/notes_map.json` — maps course IDs (e.g. `"MATH119"`) to absolute paths of notes PDFs.
- `d2l-mcp/src/study/db/piazza_map.json` — maps course IDs to Piazza class nids.

If these files are missing, notes and Piazza tools will fail silently or with an error. Document any schema changes here.

---

## Known Constraints

- D2L sessions expire after ~1 hour but auto-refresh during active use. Full re-auth (with 2FA) must be done locally.
- The MCP transport defaults to HTTP. For Claude Desktop (stdio mode), set `MCP_TRANSPORT=stdio` in the environment.
- EC2 security group must allow inbound traffic on all active MCP ports from trusted IPs or open (if using ngrok instead).
- Supabase service role key grants full DB access — never expose it client-side or commit it.

---

## Decision Log

See `docs/decisions/` for the full ADR history.
