CREATE TABLE "nail_health_scans" (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_clerk_id uuid NOT NULL,

    recommended_length VARCHAR(255),
    natural_shape VARCHAR(255),
    cuticle_health VARCHAR(255),
    cuticle_health_score INT,
    nail_strength VARCHAR(255),
    nail_strength_score INT,
    hydration VARCHAR(255),
    hydration_score INT,
    staining VARCHAR(255),
    staining_score INT,
    recommended_styles VARCHAR(255)[],
    recommended_colors VARCHAR(255)[],
    recommended_products VARCHAR(255)[],
    care_tips VARCHAR(255)[],
    notes VARCHAR(255),

    raw_json JSONB,

    inserted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
);