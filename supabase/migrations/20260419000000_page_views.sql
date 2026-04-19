create table if not exists page_views (
  id bigserial primary key,
  path text not null,
  ip_hash text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists page_views_path_idx on page_views (path);
create index if not exists page_views_created_at_idx on page_views (created_at);
