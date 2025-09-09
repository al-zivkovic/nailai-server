create table public.subscriptions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null,
    plan varchar(255),
    subscription_status varchar(255),
    subscription_source varchar(255),
    inserted_at timestamp with time zone default current_timestamp,
    updated_at timestamp with time zone default current_timestamp,
    renewal_date timestamp with time zone default null,
    cancelled_at timestamp with time zone default null
);