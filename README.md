# Horizon MCP

AI-powered access to your UWaterloo courses via the [Model Context Protocol](https://modelcontextprotocol.io).

Connect your D2L/Brightspace account and get a personal MCP server — giving any AI assistant live access to your assignments, grades, announcements, and course notes.

**Live:** [horizon.hamzaammar.ca](https://horizon.hamzaammar.ca/onboard)

## What it does

- Syncs D2L/Brightspace, Piazza, and Crowdmark asynchronously
- Semantic search over your course notes via PDF embeddings + vector search
- Exposes everything as MCP tools — plug into Claude, Cursor, or any MCP client
- Deployed on AWS (ECS + EC2) with a Go gateway handling auth

## Structure

- `d2l-mcp/` — Node.js MCP server + Go gateway, Docker, ECS deployment
- `study-mcp-app/` — React Native mobile app (Expo)
- `supabase/` — Database migrations

## Deploy

```bash
bash d2l-mcp/scripts/deploy-to-ecs.sh
```
