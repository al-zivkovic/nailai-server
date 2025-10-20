create table public.nail_customizations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  image_url text not null,
  color text not null,
  shape text not null,
  length text not null,
  finish text not null,
  storage_bucket text null,
  storage_path text null,
  inserted_at timestamp with time zone default current_timestamp,
  updated_at timestamp with time zone default current_timestamp,
  deleted_at timestamp with time zone default null
);