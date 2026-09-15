# Horizon

An MCP server that connects AI assistants to your university's D2L Brightspace and Piazza. Sign up once at **[horizon.hamzaammar.ca/onboard](https://horizon.hamzaammar.ca/onboard)**, then use Claude, ChatGPT, or any MCP-compatible client to query your courses, grades, assignments, deadlines, files, and Piazza posts — all from your AI assistant.

> Horizon is a tool for organizing and accessing your own academic data. Use in accordance with your institution's academic integrity policies.

## Hosted version

The easiest way to use Horizon is the hosted instance at **https://horizon.hamzaammar.ca/onboard**:

1. Go to https://horizon.hamzaammar.ca/onboard and create an account
2. Connect your D2L account via the browser login flow (Duo MFA supported)
3. Optionally connect Piazza
4. Copy your API key and MCP server URL from the dashboard
5. Add Horizon to your AI client (see below)

No infrastructure required.

## Connecting to your AI client

### Claude Desktop

1. Open Claude Desktop → Settings (gear icon) → Developer → Edit Config
2. Paste the following and save, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "horizon": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://horizon.hamzaammar.ca/mcp",
        "--header",
        "x-api-key: YOUR_API_KEY"
      ]
    }
  }
}
```

### Claude Code (CLI)

```bash
claude mcp add horizon -- npx mcp-remote https://horizon.hamzaammar.ca/mcp --header "x-api-key: YOUR_API_KEY"
```

### ChatGPT (Plus/Pro desktop app)

ChatGPT's desktop app supports MCP servers natively:

1. Open ChatGPT desktop → Settings → Connected Tools (or MCP Servers)
2. Add a new MCP server with:
   - **URL**: `https://horizon.hamzaammar.ca/mcp`
   - **Header**: `x-api-key: YOUR_API_KEY`
3. Save — Horizon tools will appear in your next conversation

Alternatively, add it via the config file at `~/Library/Application Support/com.openai.chat/mcp_config.json` (Mac):

```json
{
  "mcpServers": {
    "horizon": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://horizon.hamzaammar.ca/mcp",
        "--header",
        "x-api-key: YOUR_API_KEY"
      ]
    }
  }
}
```

### Poke by Interaction

1. Open Poke → Settings → MCP Servers → Add
2. Set the URL to `https://horizon.hamzaammar.ca/mcp`
3. Add request header: `x-api-key: YOUR_API_KEY`
4. Save — tools appear automatically

Replace `YOUR_API_KEY` with the key shown on your Horizon dashboard.

## What it does

Horizon exposes your academic data as MCP tools across four categories:

**D2L / Brightspace**
- `get_my_courses` — list all enrolled courses
- `get_my_grades` — check grades for any course
- `get_assignments` / `get_assignment` / `get_assignment_submissions` — assignments, due dates, submission status
- `get_upcoming_due_dates` — deadlines within a configurable time window
- `get_course_content` / `get_course_modules` / `get_course_module` / `get_course_topic` — full syllabus and lecture materials
- `get_announcements` — instructor posts and updates
- `download_file` / `read_file` / `delete_file` — download and extract text from course PDFs and files

**Piazza**
- `piazza_get_classes` / `piazza_get_posts` / `piazza_get_post` — browse class discussions
- `piazza_search` / `piazza_semantic_search` — search posts by keyword or meaning
- `piazza_sync` / `piazza_embed_missing` — sync and embed recent posts
- `piazza_suggest_for_item` — find relevant posts for a given assignment

**Notes (uploaded PDFs)**
- `notes_search` / `semantic_search_notes` — search your uploaded notes by keyword or semantically
- `notes_sync` / `notes_embed_missing` — process and embed uploaded PDFs
- `notes_suggest_for_item` — find relevant notes for a given assignment

**Study & Tasks**
- `tasks_list` / `tasks_add` / `tasks_complete` — personal task tracking
- `plan_week` — AI-generated weekly study plan based on upcoming deadlines
- `sync_all` — sync all assignments from every enrolled course at once

## Architecture

```
MCP Client (Claude, ChatGPT, Poke, etc.)
    |
    | HTTPS + Streamable HTTP
    v
Go Gateway (JWT/API key auth, rate limiting, Prometheus metrics)
    |
    | HTTP proxy  (X-User-Id header)
    v
Node.js MCP Server (tools, D2L API, Piazza API)
    |
    +---> Supabase (users, tasks, notes, pgvector embeddings)
    +---> D2L Brightspace (session cookies via VNC browser login)
    +---> Piazza (SSO cookies)
    +---> S3 (browser state persistence for headless token refresh)
    +---> OpenAI (embeddings for semantic search)
```

**Session management:** D2L sessions are refreshed automatically every 18 hours using saved ADFS browser state from S3. If the ADFS session expires (~30–90 days), Horizon falls back to stored username/password credentials for headless re-login. If Duo MFA is required, the user gets a push notification to re-authenticate via the dashboard.

## Structure

```
d2l-mcp/
  gateway/         Go reverse proxy — JWT/API key auth, rate limiting, Prometheus
  src/
    api/           REST routes (onboarding, file upload, push notifications)
    browser/       Playwright + VNC sessions for D2L login with Duo MFA
    jobs/          Background session refresh scheduler
    tools/         MCP tool implementations (D2L, files, content)
    study/         Study tools (notes, tasks, Piazza sync, semantic search)
    public/        Onboarding page (horizon.hamzaammar.ca)
  scripts/         Deployment scripts (ECS, migrations)
study-mcp-app/     React Native companion app (Expo) — push notifications
supabase/          Database migrations
```

## Self-hosting

### Prerequisites

- Node.js 20+, Go 1.22+, Docker
- Supabase project (free tier works)
- AWS account (ECS Fargate, S3, ECR, Secrets Manager)
- OpenAI API key (for semantic search embeddings)
- A D2L Brightspace instance you have student access to

### 1. Clone and configure

```bash
git clone https://github.com/hamzaammar/horizon.git
cd horizon/d2l-mcp
cp .env.template .env
# Fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, S3_BUCKET, etc.
```

### 2. Run database migrations

Run each SQL file in `src/study/db/migrations/` in order via your Supabase SQL editor.

### 3. Local development

```bash
npm install
npm run build
SKIP_JWT_AUTH=1 MCP_USER_ID=dev npm start
# Server at http://localhost:3000/mcp
```

### 4. Deploy to AWS ECS

```bash
cp task-definition.example.json task-definition.json
# Replace all <PLACEHOLDER> values with your AWS account details and secret ARNs
bash scripts/deploy-to-ecs.sh
```

See `task-definition.example.json` for the full ECS Fargate two-container configuration (gateway + backend).

### 5. Connect your MCP client

Point any MCP client at your deployed server:

| Setting | Value |
|---------|-------|
| URL | `https://your-domain.com/mcp` |
| Header | `x-api-key: <key from dashboard>` |

## Authentication

Three methods are supported at the gateway level:

- **API keys** (`hzn_...`) — never expire, best for MCP clients; generated from the dashboard
- **Supabase JWTs** — short-lived access tokens (1 hour), auto-refreshed by the gateway
- **Refresh tokens** — single-use tokens exchanged for new JWT pairs at `/auth/refresh`

All auth is handled by the Go gateway before requests reach the Node.js server. The user's ID is forwarded as `X-User-Id` and scopes all database queries.

## License

MIT
