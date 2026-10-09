-- Migration 006: Create piazza_posts table and semantic search function
-- Required for: piazza_sync, piazza_semantic_search, piazza_embed_missing, piazza_suggest_for_item

create extension if not exists vector;

create table if not exists public.piazza_posts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  course_id text not null,
  post_id text not null,
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
create index if not exists idx_piazza_posts_course on public.piazza_posts(course_id);
create index if not exists idx_piazza_posts_created on public.piazza_posts(created_at);

create index if not exists idx_piazza_posts_embedding_hnsw
  on public.piazza_posts using hnsw (embedding vector_cosine_ops);

alter table public.piazza_posts enable row level security; -- was "disable" (2026-10-09 sweep): prod runs with RLS on; service_role bypasses it

-- Semantic search RPC for piazza_posts
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
