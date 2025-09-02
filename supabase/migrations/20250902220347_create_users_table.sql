create table public.users (
    id uuid primary key default gen_random_uuid(),
    clerk_id uuid not null,
    email varchar(255) not null,
    first_name varchar(255) default null,
    last_name varchar(255) default null,
    inserted_at timestamp with time zone default current_timestamp,
    updated_at timestamp with time zone default current_timestamp,
    deleted_at timestamp with time zone default null
);

create policy "Users can view their own data" on public.users for select using (auth.uid() = id);