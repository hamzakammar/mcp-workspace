-- =========================================================
-- Study MCP / mcp-workspace — Supabase schema
-- Run this in Supabase SQL Editor on a fresh project.
-- =========================================================

-- ---------- Extensions ----------
create extension if not exists pgcrypto; -- gen_random_uuid()
create extension if not exists vector;   -- pgvector (embeddings + ANN)


-- ---------- updated_at trigger helper ----------
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;


-- =========================================================
-- 1) TASKS
-- =========================================================
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,                 -- Cognito sub or MCP_USER_ID

  -- provenance
  source text not null,                  -- 'learn' | 'manual' | etc.
  source_ref text not null,              -- stable external identifier
  course_id text not null,               -- e.g. 'CS451'

  -- content
  title text not null,
  description text,
  due_at timestamptz,
  status text not null default 'open',   -- 'open' | 'done' | 'snoozed'
  priority text not null default 'med',  -- 'low' | 'med' | 'high'

  -- links (learn url, etc.)
  links jsonb not null default '[]'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tasks_user_source_ref_unique unique (user_id, source, source_ref)
);

create index if not exists idx_tasks_user on public.tasks(user_id);
create index if not exists idx_tasks_course on public.tasks(course_id);
create index if not exists idx_tasks_due    on public.tasks(due_at);
create index if not exists idx_tasks_status on public.tasks(status);

drop trigger if exists set_tasks_updated_at on public.tasks;
create trigger set_tasks_updated_at
before update on public.tasks
for each row execute function public.set_updated_at();

alter table public.tasks enable row level security; -- was "disable" (2026-10-09 sweep): prod runs with RLS on; service_role bypasses it


-- =========================================================
-- 2) SYNC STATE
-- =========================================================
create table if not exists public.sync_state (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,

  source text not null,                  -- 'learn' | 'piazza' | 'notes'
  course_id text,                        -- null = global
  last_sync_at timestamptz not null default now(),
  cursor jsonb,                          -- pagination tokens, timestamps, etc.

  constraint sync_state_user_unique unique (user_id, source, course_id)
);

create index if not exists idx_sync_state_user on public.sync_state(user_id);
create index if not exists idx_sync_state_source on public.sync_state(source);
create index if not exists idx_sync_state_course on public.sync_state(course_id);

alter table public.sync_state enable row level security; -- was "disable" (2026-10-09 sweep): prod runs with RLS on; service_role bypasses it


-- =========================================================
-- 3) NOTES (app uploads: S3 key, title, status)
-- =========================================================
create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  s3_key text not null,
  title text not null,
  course_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  page_count int,
  status text not null default 'processing'
);

create index if not exists idx_notes_user on public.notes(user_id);
create index if not exists idx_notes_course on public.notes(course_id);
create index if not exists idx_notes_status on public.notes(status);

drop trigger if exists set_notes_updated_at on public.notes;
create trigger set_notes_updated_at
before update on public.notes
for each row execute function public.set_updated_at();

alter table public.notes enable row level security; -- was "disable" (2026-10-09 sweep): prod runs with RLS on; service_role bypasses it


-- =========================================================
-- 4) NOTE SECTIONS (PDF chunks) + Embeddings
--
-- Canonical columns: user_id, course_id, title, anchor, url, preview, content, embedding.
-- note_id links to notes table when ingested via app upload.
-- =========================================================
create table if not exists public.note_sections (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  note_id uuid references public.notes(id) on delete set null,

  course_id text not null,

  -- canonical chunk fields (used by code)
  title text not null,
  anchor text not null,
  url text not null,
  preview text,
  content text,

  -- legacy/optional fields (nullable)
  file_path text,
  section_title text,
  start_line integer,
  end_line integer,
  content_preview text,
  keywords text[],

  -- embeddings
  embedding vector(1536),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint note_sections_user_course_anchor_unique unique (user_id, course_id, anchor)
);

create index if not exists idx_note_sections_user on public.note_sections(user_id);
create index if not exists idx_note_sections_note on public.note_sections(note_id);
create index if not exists idx_note_sections_course on public.note_sections(course_id);

-- keyword search (optional)
create index if not exists idx_note_sections_title_tsv
  on public.note_sections using gin (to_tsvector('english', coalesce(title,'')));

-- ANN index (cosine)
create index if not exists idx_note_sections_embedding_hnsw
  on public.note_sections using hnsw (embedding vector_cosine_ops);

drop trigger if exists set_note_sections_updated_at on public.note_sections;
create trigger set_note_sections_updated_at
before update on public.note_sections
for each row execute function public.set_updated_at();

alter table public.note_sections enable row level security; -- was "disable" (2026-10-09 sweep): prod runs with RLS on; service_role bypasses it


-- Semantic search RPC for note_sections (user_filter = Cognito sub or MCP_USER_ID)
create or replace function public.match_note_sections (
  query_embedding vector(1536),
  match_count int default 10,
  course_filter text default null,
  user_filter text default null
)
returns table (
  id uuid,
  note_id uuid,
  course_id text,
  title text,
  url text,
  anchor text,
  preview text,
  similarity float
)
language sql stable
as $$
  select
    ns.id,
    ns.note_id,
    ns.course_id,
    ns.title,
    ns.url,
    ns.anchor,
    ns.preview,
    1 - (ns.embedding <=> query_embedding) as similarity
  from public.note_sections ns
  where ns.embedding is not null
    and (user_filter is null or ns.user_id = user_filter)
    and (course_filter is null or ns.course_id = course_filter)
  order by ns.embedding <=> query_embedding
  limit match_count;
$$;


-- =========================================================
-- 5) OFFICE HOURS
-- =========================================================
create table if not exists public.office_hours (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,

  course_id text not null,
  host text not null,                    -- 'TA' | 'prof' | name
  weekday integer not null,              -- 0=Sun ... 6=Sat
  start_time time not null,
  end_time time not null,
  location text not null,
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_office_hours_user on public.office_hours(user_id);
create index if not exists idx_office_hours_course on public.office_hours(course_id);

drop trigger if exists set_office_hours_updated_at on public.office_hours;
create trigger set_office_hours_updated_at
before update on public.office_hours
for each row execute function public.set_updated_at();

alter table public.office_hours enable row level security; -- was "disable" (2026-10-09 sweep): prod runs with RLS on; service_role bypasses it


-- =========================================================
-- 6) PIAZZA POSTS + Embeddings
-- =========================================================
create table if not exists public.piazza_posts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,

  course_id text not null,
  post_id text not null,                 -- Piazza cid
  title text not null,
  body text,
  url text not null,

  created_at timestamptz,
  updated_at timestamptz,

  metadata jsonb not null default '{}'::jsonb,

  embedding vector(1536),

  constraint piazza_posts_user_unique unique (user_id, course_id, post_id)
);

create index if not exists idx_piazza_posts_user on public.piazza_posts(user_id);
create index if not exists idx_piazza_posts_course  on public.piazza_posts(course_id);
create index if not exists idx_piazza_posts_created on public.piazza_posts(created_at);

create index if not exists idx_piazza_posts_embedding_hnsw
  on public.piazza_posts using hnsw (embedding vector_cosine_ops);

alter table public.piazza_posts enable row level security; -- was "disable" (2026-10-09 sweep): prod runs with RLS on; service_role bypasses it


-- Semantic search RPC for piazza_posts (user_filter = Cognito sub or MCP_USER_ID)
create or replace function public.match_piazza_posts (
  query_embedding vector(1536),
  match_count int default 10,
  course_filter text default null,
  user_filter text default null
)
returns table (
  id uuid,
  course_id text,
  post_id text,
  title text,
  url text,
  created_at timestamptz,
  similarity float
)
language sql stable
as $$
  select
    p.id,
    p.course_id,
    p.post_id,
    p.title,
    p.url,
    p.created_at,
    1 - (p.embedding <=> query_embedding) as similarity
  from public.piazza_posts p
  where p.embedding is not null
    and (user_filter is null or p.user_id = user_filter)
    and (course_filter is null or p.course_id = course_filter)
  order by p.embedding <=> query_embedding
  limit match_count;
$$;

-- =========================================================
-- 7) DEVICE TOKENS (Push Notifications)
-- =========================================================
create table if not exists public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  device_token text not null,
  platform text not null, -- 'ios' | 'android'
  updated_at timestamptz not null default now(),
  
  constraint device_tokens_user_token_unique unique (user_id, device_token)
);

create index if not exists idx_device_tokens_user on public.device_tokens(user_id);
create index if not exists idx_device_tokens_platform on public.device_tokens(platform);

drop trigger if exists set_device_tokens_updated_at on public.device_tokens;
create trigger set_device_tokens_updated_at
before update on public.device_tokens
for each row execute function public.set_updated_at();

alter table public.device_tokens enable row level security; -- was "disable" (2026-10-09 sweep): prod runs with RLS on; service_role bypasses it

-- =========================================================
-- End
-- =========================================================
