-- Course-website ingestion connector.
--
-- Two additive tables (RLS disabled, matching the house convention in 007/008):
--
--   course_website_snapshots — APPEND-ONLY raw fetch history + provenance. Every
--     distinct fetch outcome / content version is preserved. A successful parse
--     deduplicates only against a prior snapshot with the same content_hash +
--     parser_version + parse_status='ok'; failed parses and parser-version upgrades
--     are always distinct rows. Failures/empty/auth outcomes are recorded too
--     (content_hash null) — absence is never a delete.
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
  fetch_outcome text not null,           -- FETCH result taxonomy (fetcher.ts): success/empty/http_error/auth_required/timeout/network_error/too_large/blocked
  parse_status text not null default 'skipped', -- PARSE result, independent of fetch: 'ok' | 'failed' | 'skipped'
  content_hash text,                      -- sha256 of normalized content; null for non-content outcomes
  parser_version text not null,
  source_updated_at timestamptz,          -- from Last-Modified / page metadata when available
  fetched_at timestamptz not null default now(),
  payload text,                           -- sanitized extracted content (never credentials/cookies/tokens)
  extracted jsonb,                        -- structured parse result for this snapshot (may be null on failure)
  error text,                             -- sanitized error summary for failure outcomes
  created_at timestamptz not null default now()
);

-- Dedup guard. Deduplication is keyed by content_hash AND parser_version AND
-- parse_status so that (a) a failed parse and a successful parse of identical HTML
-- are distinct historical rows, and (b) a parser-version upgrade re-parses of record
-- rather than colliding. Application logic only reuses an existing snapshot for a
-- successful parse when a matching parse_status='ok' + parser_version row exists.
create unique index if not exists uq_course_website_snapshots_dedup
  on public.course_website_snapshots(user_id, course_code, term, url, content_hash, parser_version, parse_status)
  where content_hash is not null;

create index if not exists idx_cws_user on public.course_website_snapshots(user_id);
create index if not exists idx_cws_course on public.course_website_snapshots(course_code, term);
create index if not exists idx_cws_url on public.course_website_snapshots(url);
create index if not exists idx_cws_fetched on public.course_website_snapshots(fetched_at);

alter table public.course_website_snapshots disable row level security;

-- APPEND-ONLY enforcement at the DATABASE layer.
-- Horizon connects with the Supabase service role, which BYPASSES row-level
-- security and table GRANTs — so RLS/REVOKE cannot make this table append-only for
-- the app. A BEFORE UPDATE/DELETE trigger DOES apply to every role (including the
-- service role) and is the strongest enforcement compatible with this architecture:
-- any UPDATE or DELETE against course_website_snapshots raises an exception. Normal
-- application paths only INSERT and SELECT snapshots.
create or replace function public.course_website_snapshots_append_only()
returns trigger as $$
begin
  raise exception 'course_website_snapshots is append-only: % is not permitted', tg_op;
end;
$$ language plpgsql;

drop trigger if exists course_website_snapshots_no_mutation on public.course_website_snapshots;
create trigger course_website_snapshots_no_mutation
before update or delete on public.course_website_snapshots
for each row execute function public.course_website_snapshots_append_only();

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

-- ── Atomic per-page ingestion (single transaction) ───────────────────────────
-- Persists, for ONE successfully-parsed page, the snapshot + all canonical items +
-- all eligible website tasks in a SINGLE transaction. A plpgsql function runs in one
-- implicit transaction: any error raised anywhere below rolls back EVERY write for
-- the page (no partial canonical-item or task rows remain). The append-only rule is
-- preserved — this function only INSERTs snapshots (never updates/deletes them).
--
-- Dedup is AUTHORITATIVE and lives inside this transaction: a successful parse
-- reuses an existing snapshot ONLY when it matches the same user_id, course_code,
-- term, url, content_hash, parser_version AND parse_status='ok'. No app-provided
-- snapshot id is trusted. A previously FAILED parse (parse_status<>'ok') therefore
-- can never become the provenance snapshot for successfully parsed items, and a
-- parser-version change always re-parses of record.
--
-- Each stage is wrapped so that a failure RAISEs a message tagged with
-- 'stage=<snapshot|canonical_item|task> source_ref=<ref>'. The re-raise propagates
-- out of the function, rolling the whole transaction back, while giving the caller
-- an accurate failed stage + source_ref (parsed by the application).
create or replace function public.ingest_course_website_page(p_payload jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_snapshot_id uuid;
  v_deduped boolean := false;
  v_snap_ins int := 0;
  v_items_up int := 0;
  v_tasks_up int := 0;
  v_item jsonb;
  v_task jsonb;
  v_old_due timestamptz;
  v_old_conf jsonb;
  v_conf jsonb;
  v_new_due timestamptz;
begin
  -- SNAPSHOT stage: authoritative dedup lookup, then reuse-or-insert.
  begin
    if p_payload->>'content_hash' is not null and coalesce(p_payload->>'parse_status','ok') = 'ok' then
      select id into v_snapshot_id
        from public.course_website_snapshots
       where user_id = p_payload->>'user_id'
         and course_code = p_payload->>'course_code'
         and term = p_payload->>'term'
         and url = p_payload->>'url'
         and content_hash = p_payload->>'content_hash'
         and parser_version = p_payload->>'parser_version'
         and parse_status = 'ok'
       order by fetched_at desc
       limit 1;
    end if;

    if v_snapshot_id is not null then
      v_deduped := true;
    else
      insert into public.course_website_snapshots(
        user_id, course_code, term, url, page_type, http_status, fetch_outcome,
        parse_status, content_hash, parser_version, source_updated_at, fetched_at,
        payload, extracted, error)
      values (
        p_payload->>'user_id', p_payload->>'course_code', p_payload->>'term',
        p_payload->>'url', p_payload->>'page_type', nullif(p_payload->>'http_status','')::int,
        p_payload->>'fetch_outcome', coalesce(p_payload->>'parse_status','ok'),
        p_payload->>'content_hash', p_payload->>'parser_version',
        nullif(p_payload->>'source_updated_at','')::timestamptz, now(),
        p_payload->>'payload', p_payload->'extracted', p_payload->>'error')
      returning id into v_snapshot_id;
      v_snap_ins := 1;
    end if;
  exception when others then
    raise exception 'stage=snapshot source_ref= : %', sqlerrm;
  end;

  -- CANONICAL ITEM stage (upsert; preserve + flag conflicting due dates over time).
  for v_item in select * from jsonb_array_elements(coalesce(p_payload->'items', '[]'::jsonb)) loop
    begin
      v_new_due := nullif(v_item->>'due_at','')::timestamptz;
      select due_at, conflicts into v_old_due, v_old_conf
        from public.course_website_items
       where user_id = v_item->>'user_id' and source = 'website' and source_ref = v_item->>'source_ref';
      v_conf := coalesce(v_old_conf, '[]'::jsonb) || coalesce(v_item->'conflicts', '[]'::jsonb);
      if v_old_due is not null and v_new_due is not null and v_old_due <> v_new_due then
        v_conf := v_conf || jsonb_build_array(jsonb_build_object(
          'field','due_at','kind','temporal-change',
          'previous', to_jsonb(v_old_due), 'current', to_jsonb(v_new_due), 'seenAt', to_jsonb(now())));
      end if;
      insert into public.course_website_items(
        user_id, course_code, term, item_type, title, due_at, due_text, points, url,
        status_note, source, source_ref, snapshot_id, source_url, conflicts, last_seen_at, updated_at)
      values(
        v_item->>'user_id', v_item->>'course_code', v_item->>'term', v_item->>'item_type',
        v_item->>'title', v_new_due, v_item->>'due_text', v_item->>'points', v_item->>'url',
        v_item->>'status_note', 'website', v_item->>'source_ref', v_snapshot_id,
        v_item->>'source_url', v_conf, now(), now())
      on conflict (user_id, source, source_ref) do update set
        course_code = excluded.course_code, term = excluded.term, item_type = excluded.item_type,
        title = excluded.title, due_at = excluded.due_at, due_text = excluded.due_text,
        points = excluded.points, url = excluded.url, status_note = excluded.status_note,
        snapshot_id = excluded.snapshot_id, source_url = excluded.source_url,
        conflicts = excluded.conflicts, last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at;
      v_items_up := v_items_up + 1;
    exception when others then
      raise exception 'stage=canonical_item source_ref=% : %', coalesce(v_item->>'source_ref',''), sqlerrm;
    end;
  end loop;

  -- TASK stage (upsert into the canonical read path).
  for v_task in select * from jsonb_array_elements(coalesce(p_payload->'tasks', '[]'::jsonb)) loop
    begin
      insert into public.tasks(user_id, source, source_ref, course_id, title, description, due_at, links, updated_at)
      values(
        v_task->>'user_id', 'website', v_task->>'source_ref', v_task->>'course_id',
        v_task->>'title', v_task->>'description', nullif(v_task->>'due_at','')::timestamptz,
        coalesce(v_task->'links', '[]'::jsonb), now())
      on conflict (user_id, source, source_ref) do update set
        course_id = excluded.course_id, title = excluded.title, description = excluded.description,
        due_at = excluded.due_at, links = excluded.links, updated_at = excluded.updated_at;
      v_tasks_up := v_tasks_up + 1;
    exception when others then
      raise exception 'stage=task source_ref=% : %', coalesce(v_task->>'source_ref',''), sqlerrm;
    end;
  end loop;

  return jsonb_build_object(
    'snapshot_id', v_snapshot_id, 'deduped', v_deduped,
    'snapshots_inserted', v_snap_ins, 'items_upserted', v_items_up, 'tasks_upserted', v_tasks_up);
end;
$$;
