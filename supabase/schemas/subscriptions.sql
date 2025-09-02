CREATE TABLE "subscriptions" (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_clerk_id uuid NOT NULL,
    
    plan VARCHAR(255),
    status VARCHAR(255),
    source VARCHAR(255),
    inserted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    renewal_date TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    cancelled_at TIMESTAMP WITH TIME ZONE DEFAULT NULL
);