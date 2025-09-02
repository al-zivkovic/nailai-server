alter table public.users
drop column id;

alter table public.users
drop column clerk_id;

alter table public.users
add column user_clerk_id uuid not null;