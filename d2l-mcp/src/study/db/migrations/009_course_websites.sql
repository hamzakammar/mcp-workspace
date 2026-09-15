-- Course-website ingestion connector.
--
-- Two additive tables (RLS disabled, matching the house convention in 007/008):
--
--   course_website_snapshots — APPEND-ONLY raw fetch history + provenance. Every
--     distinct fetch outcome / content version is preserved. Deduplicated on
--     (user, course, term, url, content_hash) so an unchanged re-fetch does not
--     create a new row, while changed content always does. Failures/empty/auth
--     outcomes are recorded too (content_hash null) — absence is never a delete.
--
--   course_website_items — canonical normalized academic items (assignments,
--     quizzes, exams, deadlines, lectures, tutorials, policies, announcements,
--     reference files) with provenance back to the snapshot + source URL. Upserted
--     idempotently on (user, course, term, source_ref). Conflicting values across
--     sources are preserved in `conflicts` and flagged rather than silently chosen.

-- ── Append-only raw snapshot ledger ──────────────────────────────────────────
create table if not exists public.course_website_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  course_code text not null,              -- e.g. 'SE212', 'CS241'
  term text not null,                     -- YYMM-style, e.g. '1269' (Fall 2026)
  url text not null,                      -- exact fetched URL
  page_type text not null,               -- 'home'|'schedule'|'assignments'|'notes'|'tutorials'|'policies'|'announcements'|'reference'
  http_status int,                        -- null when the request never completed (timeout/DNS/SSRF)
  fetch_outcome text not null,           -- see FetchOutcome taxonomy in fetcher.ts
  content_hash text,                      -- sha256 of normalized content; null for non-content outcomes
  parser_version text not null,
  source_updated_at timestamptz,          -- from Last-Modified / page metadata when available
  fetched_at timestamptz not null default now(),
  payload text,                           -- sanitized extracted content (never credentials/cookies/tokens)
  extracted jsonb,                        -- structured parse result for this snapshot (may be null on failure)
  error text,                             -- sanitized error summary for failure outcomes
  created_at timestamptz not null default now()
);

-- Dedup guard: an identical (content_hash) fetch for the same source is stored once.
create unique index if not exists uq_course_website_snapshots_dedup
  on public.course_website_snapshots(user_id, course_code, term, url, content_hash)
  where content_hash is not null;

create index if not exists idx_cws_user on public.course_website_snapshots(user_id);
create index if not exists idx_cws_course on public.course_website_snapshots(course_code, term);
create index if not exists idx_cws_url on public.course_website_snapshots(url);
create index if not exists idx_cws_fetched on public.course_website_snapshots(fetched_at);

alter table public.course_website_snapshots disable row level security;

-- ── Canonical normalized items with provenance ───────────────────────────────
create table if not exists public.course_website_items (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  course_code text not null,
  term text not null,

  item_type text not null,               -- 'assignment'|'quiz'|'exam'|'project'|'deadline'|'lecture'|'tutorial'|'policy'|'announcement'|'reference'
  title text not null,
  due_at timestamptz,                     -- normalized America/Toronto instant, null if undated
  due_text text,                          -- ORIGINAL date text from the source, preserved verbatim
  points text,
  url text,                               -- deep link / source url for the item
  status_note text,                       -- e.g. 'submission status unknown (MarkUs)' — blind-spot marker

  -- provenance
  source text not null default 'website',
  source_ref text not null,               -- stable id: `${course}|${term}|${page_type}|${slug}`
  snapshot_id uuid references public.course_website_snapshots(id),
  source_url text,                        -- the page URL this item was parsed from

  -- cross-source conflict flags (never silently resolved)
  conflicts jsonb not null default '[]'::jsonb,

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint course_website_items_source_ref_unique unique (user_id, source, source_ref)
);

create index if not exists idx_cwi_user on public.course_website_items(user_id);
create index if not exists idx_cwi_course on public.course_website_items(course_code, term);
create index if not exists idx_cwi_due on public.course_website_items(due_at);
create index if not exists idx_cwi_type on public.course_website_items(item_type);

drop trigger if exists set_course_website_items_updated_at on public.course_website_items;
create trigger set_course_website_items_updated_at
before update on public.course_website_items
for each row execute function public.set_updated_at();

alter table public.course_website_items disable row level security;
