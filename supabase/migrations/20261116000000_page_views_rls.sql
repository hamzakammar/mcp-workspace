-- page_views (onboarding analytics) was created without RLS and kept the
-- default anon/authenticated grants, so anyone holding the public anon key
-- could read or write it via PostgREST. Only the backend (service_role) uses it.
--
-- ingest_course_website_page(jsonb) is called only by the backend with the
-- service-role key; authenticated users must not be able to invoke it directly
-- (it writes rows for whatever user_id the payload names).
--
-- Idempotent: safe to re-run.

begin;

do $$
begin
  if to_regclass('public.page_views') is not null then
    alter table public.page_views enable row level security;
    revoke all on public.page_views from anon, authenticated;
    if to_regclass('public.page_views_id_seq') is not null then
      revoke all on sequence public.page_views_id_seq from anon, authenticated;
    end if;
  end if;

  if to_regprocedure('public.ingest_course_website_page(jsonb)') is not null then
    revoke execute on function public.ingest_course_website_page(jsonb) from anon, authenticated, public;
    grant execute on function public.ingest_course_website_page(jsonb) to service_role;
  end if;
end
$$;

commit;
