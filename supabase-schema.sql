-- Run this once in your Supabase project's SQL Editor (Supabase dashboard > SQL Editor > New query).

create extension if not exists pgcrypto;

create table if not exists assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  course text,
  title text not null,
  date date not null,
  time text,
  type text not null default 'assignment',
  completed boolean not null default false,
  semester text not null default 'fall',
  created_at timestamptz default now()
);
alter table assignments enable row level security;
create policy "users manage their own assignments" on assignments
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists course_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  course text not null,
  filename text not null,
  semester text not null default 'fall',
  created_at timestamptz default now()
);
alter table course_sources enable row level security;
create policy "users manage their own course sources" on course_sources
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
