import { getAuth } from '@clerk/express';
import getSupabase from './supabase.js';

export async function getOrCreateInternalUserId(req: any): Promise<string> {
  const { userId } = getAuth(req);
  if (!userId) throw new Error('Unauthorized');

  const supabase = getSupabase();

  const { data: existing, error: selectError } = await supabase
    .from('users')
    .select('id')
    .eq('clerk_id', userId)
    .maybeSingle();

  if (selectError) throw selectError;
  if (existing?.id) return existing.id as string;

  throw new Error('User not found. Complete sign-in first.');
}

export default getOrCreateInternalUserId;


