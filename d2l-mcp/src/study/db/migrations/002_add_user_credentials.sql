-- Add user_credentials table for storing D2L and Piazza credentials
-- Run this on your AWS RDS PostgreSQL database
-- Note: In production, passwords should be encrypted

create table if not exists public.user_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  service text not null,              -- 'd2l' | 'piazza'
  
  -- D2L fields
  host text,                          -- D2L host (e.g., learn.ul.ie)
  username text,                      -- D2L username
  
  -- Piazza fields  
  email text,                         -- Piazza email
  
  -- Common fields
  password text not null,              -- Password (TODO: encrypt in production)
  
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  
  constraint user_credentials_user_service_unique unique (user_id, service)
);

create index if not exists idx_user_credentials_user on public.user_credentials(user_id);
create index if not exists idx_user_credentials_service on public.user_credentials(service);

-- Add updated_at trigger
drop trigger if exists set_user_credentials_updated_at on public.user_credentials;
create trigger set_user_credentials_updated_at
before update on public.user_credentials
for each row execute function public.set_updated_at();

-- Disable RLS for now (enable and add policies in production)
alter table public.user_credentials enable row level security; -- was "disable" (2026-10-09 sweep): prod runs with RLS on; service_role bypasses it
