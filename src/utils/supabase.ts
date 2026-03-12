import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cachedClient: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const SUPABASE_URL = process.env.SUPABASE_URL as string | undefined;
  // Support both old and new env var names for backwards compatibility
  const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined;

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    const missing = [];
    if (!SUPABASE_URL) missing.push('SUPABASE_URL');
    if (!SUPABASE_SECRET_KEY) missing.push('SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)');
    console.error(`Supabase env vars missing: ${missing.join(', ')}`);
    throw new Error(`Supabase env vars missing: ${missing.join(', ')}`);
  }

  // Log masked key for debugging (first 8, last 4 chars)
  const keyPreview = SUPABASE_SECRET_KEY.length > 12
    ? `${SUPABASE_SECRET_KEY.substring(0, 8)}...${SUPABASE_SECRET_KEY.substring(SUPABASE_SECRET_KEY.length - 4)}`
    : '***';
  console.log(`Initializing Supabase client:`);
  console.log(`  URL: ${SUPABASE_URL.substring(0, 30)}...`);
  console.log(`  Secret Key: ${keyPreview}`);
  
  cachedClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false }
  });
  return cachedClient;
}

export default getSupabase;


