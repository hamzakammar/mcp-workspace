-- Add course_outlines table for caching parsed outline data from outline.uwaterloo.ca

create table if not exists public.course_outlines (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  course_code text not null,          -- e.g. 'CS135'
  term text not null,                 -- e.g. '1251' (YYMM format)
  title text,
  raw_html text,
  assessments jsonb,                  -- [{name, weight, date, notes}]
  schedule jsonb,                     -- [{week, date, topic, readings}]
  instructors jsonb,                  -- [{name, email, office, officeHours}]
  learning_objectives text[],
  outline_url text,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint course_outlines_user_unique unique (user_id, course_code, term)
);

create index if not exists idx_course_outlines_user on public.course_outlines(user_id);
create index if not exists idx_course_outlines_course on public.course_outlines(course_code);


alter table public.course_outlines disable row level security;
