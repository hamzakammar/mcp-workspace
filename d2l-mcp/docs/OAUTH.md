# OAuth 2.1 for the Horizon MCP transport

OAuth is a **secondary** authentication method for the remote MCP server at
`https://horizon.hamzaammar.ca/mcp`. It lets clients such as **Sentience**
connect with a zero-setup, standards-compliant flow (discovery → Dynamic Client
Registration → authorization-code + PKCE → bearer token) **without** manually
supplying a Horizon API key.

The existing **API-key** flow (`x-api-key` / `Bearer hzn_…`, `api_keys` table) is
unchanged and takes precedence. Both methods resolve to the **same Horizon user**
(a Supabase `auth.users` id) and produce the identical authenticated tool
context. There is no second user model.

---

## Architecture

```
MCP client ──HTTPS──▶ ALB ──▶ Go gateway (:8080) ──▶ Node worker (:3000, 127.0.0.1)
                                   │                        │
                    auth chokepoint: resolves           implements the OAuth
                    API key / OAuth token / Supabase     Authorization Server
                    JWT → injects X-User-Id              endpoints + MCP tools
```

- **Node worker** (`src/api/oauth/`) implements the OAuth Authorization Server:
  discovery metadata, DCR, `/authorize` (login + consent, reusing the existing
  Supabase email/password login), `/token`, `/revoke`.
- **Go gateway** (`gateway/middleware/auth.go`) validates OAuth **access tokens**
  (`hzn_at_…`) on protected routes — hashes the token, looks it up in
  `oauth_access_tokens`, checks revocation/expiry, and injects `X-User-Id`
  exactly like the API-key path. It also returns the spec-compliant
  `WWW-Authenticate` header on `/mcp` 401s.

### Endpoints (all under `https://horizon.hamzaammar.ca`)

| Path | Purpose |
|------|---------|
| `/.well-known/oauth-protected-resource` | Protected-resource metadata (RFC 9728) |
| `/.well-known/oauth-authorization-server` | Authorization-server metadata (RFC 8414) |
| `/register` | Dynamic Client Registration (RFC 7591) |
| `/authorize` | Authorization endpoint (login + consent, code + PKCE) |
| `/token` | Token endpoint (authorization_code, refresh_token w/ rotation) |
| `/revoke` | Token revocation (RFC 7009) |

Scope: a single `horizon:mcp` scope. Access tokens are short-lived (15 min by
default); refresh tokens rotate on every use. Codes are single-use and expire in
60 s. Client secrets, codes, and tokens are stored only as SHA-256 hashes.

---

## Deployment

The rollout is backwards-compatible and can be staged. API-key and Supabase-JWT
clients are unaffected at every step.

### 1. Apply the database migration (deploy this FIRST)

`src/study/db/migrations/008_oauth.sql` is purely additive
(`CREATE TABLE IF NOT EXISTS`) and safe to run before the new app version:

```bash
# Against Supabase (SQL editor) or psql:
psql "$SUPABASE_DB_URL" -f src/study/db/migrations/008_oauth.sql
```

Creates `oauth_clients`, `oauth_authorization_codes`, `oauth_access_tokens`,
`oauth_refresh_tokens`.

### 2. Environment variables

Already added to `task-definition.json`:

- `PUBLIC_BASE_URL=https://horizon.hamzaammar.ca` — on **both** the gateway and
  backend containers. Drives discovery metadata and the `WWW-Authenticate`
  pointer.

The gateway already has `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (used to
resolve OAuth access tokens). No new gateway secret is required.

**`OAUTH_SESSION_SECRET` (dedicated, already provisioned):** the interim
authorization-request blob is HMAC-signed with its own secret — deliberately
separate from `STUDY_MCP_TOKEN`. The secret has been created in Secrets Manager
and wired into the **backend** container's `secrets` array in
`task-definition.json`:

```json
{
  "name": "OAUTH_SESSION_SECRET",
  "valueFrom": "arn:aws:secretsmanager:us-east-1:051140201449:secret:horizon-mcp/oauth-session-secret-NNxDoY"
}
```

The `ecsTaskExecutionRole` already carries the managed `SecretsManagerReadWrite`
policy, so no IAM change is needed to inject it.

To rotate it:

```bash
aws secretsmanager put-secret-value \
  --secret-id horizon-mcp/oauth-session-secret \
  --secret-string "$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
```

> Do not commit secret values. Only ARNs belong in the task definition. If
> `OAUTH_SESSION_SECRET` is ever unset, the code falls back to `STUDY_MCP_TOKEN`
> and logs a loud warning — that fallback is for local dev only, never prod.

### 3. Build & deploy both images

```bash
# Node backend
npm run build
docker build -t <ecr>/study-mcp-backend:latest . && docker push <ecr>/study-mcp-backend:latest
# Go gateway
docker build -t <ecr>/study-mcp-gateway:latest gateway/ && docker push <ecr>/study-mcp-gateway:latest
# Register new task def revision + update service
aws ecs register-task-definition --cli-input-json file://task-definition.json
aws ecs update-service --cluster <cluster> --service <service> --force-new-deployment
```

---

## Local verification

Run the gateway + backend locally (or point a client at a dev instance). With
`SKIP_GATEWAY_AUTH` **unset** so real auth runs:

```bash
export PUBLIC_BASE_URL=http://localhost:8080
```

1. **Discovery metadata**

   ```bash
   curl -s http://localhost:8080/.well-known/oauth-protected-resource | jq
   curl -s http://localhost:8080/.well-known/oauth-authorization-server | jq
   ```
   Expect `resource` = `http://localhost:8080/mcp`, `authorization_servers`,
   `code_challenge_methods_supported: ["S256"]`.

2. **401 advertises OAuth** — unauthenticated `/mcp` returns the pointer:

   ```bash
   curl -si -X POST http://localhost:8080/mcp | grep -i www-authenticate
   # WWW-Authenticate: Bearer resource_metadata="http://localhost:8080/.well-known/oauth-protected-resource"
   ```

3. **Dynamic Client Registration**

   ```bash
   curl -s -X POST http://localhost:8080/register \
     -H 'content-type: application/json' \
     -d '{"client_name":"Local Test","redirect_uris":["http://127.0.0.1:9999/callback"]}' | jq
   ```
   Returns a `client_id` and `token_endpoint_auth_method: "none"`.

4. **Authorize (browser)** — build the URL with a PKCE S256 challenge:

   ```bash
   VERIFIER=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
   CHALLENGE=$(node -e "console.log(require('crypto').createHash('sha256').update('$VERIFIER').digest('base64url'))")
   echo "http://localhost:8080/authorize?response_type=code&client_id=<CLIENT_ID>&redirect_uri=http://127.0.0.1:9999/callback&code_challenge=$CHALLENGE&code_challenge_method=S256&scope=horizon:mcp&state=xyz&resource=http://localhost:8080/mcp"
   ```
   Open it, log in with a Horizon (Supabase) email/password, approve. You'll be
   redirected to `…/callback?code=hzn_ac_…&state=xyz`.

5. **Token exchange**

   ```bash
   curl -s -X POST http://localhost:8080/token \
     -H 'content-type: application/x-www-form-urlencoded' \
     -d "grant_type=authorization_code&code=<CODE>&redirect_uri=http://127.0.0.1:9999/callback&client_id=<CLIENT_ID>&code_verifier=$VERIFIER" | jq
   ```
   Returns `access_token: hzn_at_…`, `refresh_token: hzn_rt_…`, `expires_in: 900`.

6. **Call `/mcp` with the bearer token**

   ```bash
   curl -s -X POST http://localhost:8080/mcp \
     -H "Authorization: Bearer <ACCESS_TOKEN>" \
     -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```
   Succeeds as the authorized user. A second exchange of the same `code` fails
   with `invalid_grant` (single-use).

Automated coverage: `npm test` (Node, `tests/oauth.test.ts`) and
`go test ./middleware/` (gateway).

---

## Production verification — connecting Sentience

1. In Sentience, add an MCP server with URL **`https://horizon.hamzaammar.ca/mcp`**
   and choose OAuth (no API key).
2. Sentience fetches `/.well-known/oauth-protected-resource`, then the
   authorization-server metadata, and **dynamically registers** itself
   (`POST /register`).
3. It opens the Horizon **authorization page** in a browser; sign in with your
   Horizon account and approve the `horizon:mcp` scope.
4. Sentience completes the **authorization-code + PKCE** exchange at `/token`,
   receives a short-lived `hzn_at_` bearer, and calls `/mcp` as you.
5. Verify tools work (e.g. list courses / tasks). Confirm the same account's
   data appears as with the API key.

Manual production smoke test:

```bash
# 1. Discovery
curl -s https://horizon.hamzaammar.ca/.well-known/oauth-protected-resource | jq
# 2. 401 pointer
curl -si -X POST https://horizon.hamzaammar.ca/mcp | grep -i www-authenticate
# 3. Register
curl -s -X POST https://horizon.hamzaammar.ca/register \
  -H 'content-type: application/json' \
  -d '{"client_name":"Smoke Test","redirect_uris":["http://127.0.0.1:9999/callback"]}' | jq
# 4-6. authorize (browser) → token → call /mcp, as in the local steps above,
#      using https://horizon.hamzaammar.ca and resource=https://horizon.hamzaammar.ca/mcp
```

Existing API-key clients must continue to work unchanged throughout:

```bash
curl -s -X POST https://horizon.hamzaammar.ca/mcp \
  -H "Authorization: Bearer hzn_<your-existing-api-key>" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## Security properties

- Redirect URIs validated by **exact match** against the registered set.
- **PKCE S256 required**; `plain` and missing challenges are rejected.
- RFC 8707 `resource` parameter validated against the MCP resource URL.
- Authorization codes are **single-use** (atomic consume) and expire in 60 s.
- Access tokens are short-lived; **refresh tokens rotate** on every use.
- Client secrets, codes, and tokens are stored **only as SHA-256 hashes**.
- Authorization codes, access/refresh tokens, API keys, cookies, and D2L session
  data are **never logged**.
- Each token resolves to exactly one Horizon `user_id`; tools scope every query
  by that id (`getUserId()`), so one user can never reach another's data.
