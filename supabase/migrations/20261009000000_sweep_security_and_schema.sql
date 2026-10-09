-- 2026-10-09 sweep: close anon-writable tables, add schema the code already
-- depends on, and make user deletion actually clean up.
--
-- Applied to prod (qialmumlcezeqvyyhjlu) via the Management API SQL endpoint.
-- Every statement is idempotent so re-running is harmless.

begin;

-- ── 1. course_outlines / bookmarks had RLS OFF with full anon grants ─────────
-- The anon key ships in the mobile app, so these were world readable/writable.
-- Backend uses service_role (bypasses RLS); the app reaches bookmarks via the API.
alter table public.course_outlines enable row level security;
alter table public.bookmarks enable row level security;

drop policy if exists course_outlines_owner on public.course_outlines;
create policy course_outlines_owner on public.course_outlines for all to authenticated
  using ((select auth.uid())::text = user_id) with check ((select auth.uid())::text = user_id);

drop policy if exists bookmarks_owner on public.bookmarks;
create policy bookmarks_owner on public.bookmarks for all to authenticated
  using ((select auth.uid())::text = user_id) with check ((select auth.uid())::text = user_id);

-- anon never needs table access: backend = service_role, app = authenticated.
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;

-- Secrets tables are server-only; signed-in clients have no business reading them.
revoke all on public.user_credentials, public.api_keys, public.credential_access_log,
  public.oauth_clients, public.oauth_authorization_codes, public.oauth_access_tokens,
  public.oauth_refresh_tokens
  from authenticated;

-- ── 2. note_sections: notes_sync upserts ON CONFLICT (user_id,course_id,anchor) ─
create unique index if not exists note_sections_user_course_anchor_unique
  on public.note_sections (user_id, course_id, anchor);
create index if not exists idx_note_sections_user on public.note_sections (user_id);
create index if not exists idx_note_sections_note on public.note_sections (note_id);
create index if not exists idx_notes_user on public.notes (user_id);

-- ── 3. match_note_sections: callers read title/url/anchor/preview, and synced
--      sections have no note_id, so the old inner join on notes hid them. ───────
drop function if exists public.match_note_sections(vector, integer, text, uuid);
create function public.match_note_sections(
  query_embedding vector(1536),
  match_count int default 10,
  course_filter text default null,
  user_filter uuid default null
)
returns table(id uuid, note_id uuid, course_id text, title text, url text, anchor text,
              preview text, content text, similarity float)
language sql stable
set search_path = public, pg_temp
as $$
  select ns.id, ns.note_id, ns.course_id, ns.title, ns.url, ns.anchor, ns.preview, ns.content,
         1 - (ns.embedding <=> query_embedding)
  from public.note_sections ns
  where ns.embedding is not null
    and (user_filter is null or ns.user_id = user_filter)
    and (course_filter is null or ns.course_id = course_filter)
  order by ns.embedding <=> query_embedding
  limit match_count;
$$;

-- ── 4. Push tables referenced by src/api/push.ts but never created in prod ───
create table if not exists public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  device_token text not null,
  platform text not null check (platform in ('ios', 'android')),
  updated_at timestamptz not null default now(),
  constraint device_tokens_user_token_unique unique (user_id, device_token)
);
create index if not exists idx_device_tokens_user on public.device_tokens (user_id);
alter table public.device_tokens enable row level security;

create table if not exists public.sync_state (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  source text not null,
  course_id text,
  last_sync_at timestamptz not null default now(),
  cursor jsonb,
  -- push.ts upserts with course_id = null, which needs NULLS NOT DISTINCT
  constraint sync_state_user_unique unique nulls not distinct (user_id, source, course_id)
);
create index if not exists idx_sync_state_user on public.sync_state (user_id);
alter table public.sync_state enable row level security;
revoke all on public.device_tokens, public.sync_state from anon, authenticated;

-- ── 5. User deletion: FKs were NO ACTION, so deleting an auth user failed while
--      their rows existed. Orphaned api_keys still authenticated as a ghost user. ─
delete from public.api_keys where user_id not in (select id from auth.users);
alter table public.api_keys drop constraint if exists api_keys_user_fk;
alter table public.api_keys add constraint api_keys_user_fk
  foreign key (user_id) references auth.users(id) on delete cascade;

alter table public.notes drop constraint if exists notes_user_id_fkey;
alter table public.notes add constraint notes_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.note_sections drop constraint if exists note_sections_user_id_fkey;
alter table public.note_sections add constraint note_sections_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.user_credentials drop constraint if exists user_credentials_user_id_fkey;
alter table public.user_credentials add constraint user_credentials_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.piazza_posts drop constraint if exists piazza_posts_user_id_fkey;
alter table public.piazza_posts add constraint piazza_posts_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

-- Chunks of deleted notes were still returned by semantic_search.
delete from public.note_chunks where note_id is not null and note_id not in (select id from public.notes);

-- ── 6. Pin search_path on functions (advisor: function_search_path_mutable) ──
alter function public.semantic_search(vector, uuid, text, integer, double precision) set search_path = public, pg_temp;
alter function public.match_piazza_posts(vector, integer, text, text) set search_path = public, pg_temp;
alter function public.set_updated_at() set search_path = public, pg_temp;
alter function public.course_website_snapshots_append_only() set search_path = public, pg_temp;
alter function public.ingest_course_website_page(jsonb) set search_path = public, pg_temp;

revoke execute on function public.semantic_search(vector, uuid, text, integer, double precision),
  public.match_piazza_posts(vector, integer, text, text),
  public.match_note_sections(vector, integer, text, uuid),
  public.ingest_course_website_page(jsonb)
  from anon, public;
grant execute on function public.semantic_search(vector, uuid, text, integer, double precision),
  public.match_piazza_posts(vector, integer, text, text),
  public.match_note_sections(vector, integer, text, uuid),
  public.ingest_course_website_page(jsonb)
  to authenticated, service_role;

commit;
