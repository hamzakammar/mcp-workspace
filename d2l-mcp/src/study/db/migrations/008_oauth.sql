-- =========================================================
-- Migration 008 — OAuth 2.1 Authorization Server for the MCP transport
--
-- Adds a standards-compliant OAuth server (RFC 6749/7636/7591/7009,
-- MCP 2026-07-28 authorization spec) as a SECONDARY auth method for
-- https://horizon.hamzaammar.ca/mcp. The existing API-key flow
-- (api_keys table, migration 005) is unaffected.
--
-- OAuth identities map onto the EXISTING Horizon user model: user_id
-- always references a Supabase auth.users id (same column already used
-- by api_keys.user_id, tasks.user_id, etc.). No second user model.
--
-- This migration is purely additive (CREATE TABLE IF NOT EXISTS) and is
-- backwards-compatible: it can be applied safely BEFORE the new
-- application version ships. The tables are unused until the OAuth code
-- is deployed.
--
-- All secrets/codes/tokens are stored ONLY as SHA-256 hex hashes.
-- =========================================================

create extension if not exists pgcrypto; -- gen_random_uuid()

-- ---------- Registered OAuth clients (Dynamic Client Registration) ----------
create table if not exists public.oauth_clients (
  client_id                    text primary key,
  -- SHA-256 hex of the client secret; NULL for public (PKCE-only) clients
  -- such as Sentience registered via DCR with token_endpoint_auth_method=none.
  client_secret_hash           text,
  client_name                  text,
  redirect_uris                jsonb not null default '[]'::jsonb,
  grant_types                  jsonb not null default '["authorization_code","refresh_token"]'::jsonb,
  response_types               jsonb not null default '["code"]'::jsonb,
  scope                        text not null default 'horizon:mcp',
  token_endpoint_auth_method   text not null default 'none',
  created_at                   timestamptz not null default now()
);

-- ---------- Authorization codes (single-use, short-lived, PKCE-bound) ----------
create table if not exists public.oauth_authorization_codes (
  code_hash             text primary key,           -- SHA-256 hex of the code
  client_id             text not null,
  user_id               uuid not null,              -- Supabase auth.users id
  redirect_uri          text not null,
  code_challenge        text not null,              -- PKCE S256 challenge
  code_challenge_method text not null default 'S256',
  scope                 text not null default 'horizon:mcp',
  resource              text,                        -- RFC 8707 resource indicator
  consumed              boolean not null default false,
  expires_at            timestamptz not null,
  created_at            timestamptz not null default now()
);

create index if not exists idx_oauth_codes_expires on public.oauth_authorization_codes(expires_at);

-- ---------- Access tokens (opaque bearer, short-lived, hashed) ----------
create table if not exists public.oauth_access_tokens (
  token_hash   text primary key,                     -- SHA-256 hex of the access token
  client_id    text not null,
  user_id      uuid not null,                         -- Supabase auth.users id
  scope        text not null default 'horizon:mcp',
  resource     text,
  revoked      boolean not null default false,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);

create index if not exists idx_oauth_access_user on public.oauth_access_tokens(user_id);
create index if not exists idx_oauth_access_expires on public.oauth_access_tokens(expires_at);

-- ---------- Refresh tokens (rotated on use, hashed) ----------
create table if not exists public.oauth_refresh_tokens (
  token_hash        text primary key,                -- SHA-256 hex of the refresh token
  client_id         text not null,
  user_id           uuid not null,                    -- Supabase auth.users id
  scope             text not null default 'horizon:mcp',
  resource          text,
  revoked           boolean not null default false,
  -- token_hash of the refresh token this one replaced (rotation audit trail).
  rotated_from      text,
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now()
);

create index if not exists idx_oauth_refresh_user on public.oauth_refresh_tokens(user_id);

-- Service-role key is used by both the Go gateway (REST) and the Node worker
-- (supabase-js), which bypass RLS. Disable RLS to match the other tables in
-- this schema and avoid accidental anon access.
alter table public.oauth_clients               disable row level security;
alter table public.oauth_authorization_codes   disable row level security;
alter table public.oauth_access_tokens         disable row level security;
alter table public.oauth_refresh_tokens        disable row level security;
