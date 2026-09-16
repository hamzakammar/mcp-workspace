-- Fix: ingest_course_website_page must not depend on a unique constraint on
-- public.tasks. Production's tasks table has no unique index on
-- (user_id, source, source_ref) — the rest of the codebase (sync.ts, tasks_add)
-- writes tasks via check-exists-then-insert and never used ON CONFLICT. The 009
-- version of this RPC used `on conflict (user_id, source, source_ref)` for the task
-- upsert, which raised "no unique or exclusion constraint matching the ON CONFLICT
-- specification" and (correctly) rolled the whole page back.
--
-- This migration redefines the function so the TASK write uses UPDATE-then-INSERT
-- (constraint-free, transactional, matching the established pattern). The canonical
-- item upsert keeps ON CONFLICT because course_website_items DOES have its unique
-- constraint (created in 009). Everything else is unchanged from 009.
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

  -- TASK stage: UPDATE-then-INSERT (no ON CONFLICT — matches sync.ts/tasks_add and
  -- does not require a unique constraint on public.tasks).
  for v_task in select * from jsonb_array_elements(coalesce(p_payload->'tasks', '[]'::jsonb)) loop
    begin
      update public.tasks set
        course_id = v_task->>'course_id',
        title = v_task->>'title',
        description = v_task->>'description',
        due_at = nullif(v_task->>'due_at','')::timestamptz,
        links = coalesce(v_task->'links', '[]'::jsonb),
        updated_at = now()
      where user_id = v_task->>'user_id' and source = 'website' and source_ref = v_task->>'source_ref';
      if not found then
        insert into public.tasks(user_id, source, source_ref, course_id, title, description, due_at, links, status, updated_at)
        values(
          v_task->>'user_id', 'website', v_task->>'source_ref', v_task->>'course_id',
          v_task->>'title', v_task->>'description', nullif(v_task->>'due_at','')::timestamptz,
          coalesce(v_task->'links', '[]'::jsonb), 'open', now());
      end if;
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
