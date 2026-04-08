alter table public.users add column if not exists is_subscribed boolean not null default false;
