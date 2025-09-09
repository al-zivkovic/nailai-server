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
    .single();

  if (existing?.id) return existing.id as string;

  if (selectError && selectError.code !== 'PGRST116') {
    // PGRST116 = No rows found for single() — safe to proceed to insert
    throw selectError;
  }

  const { data: created, error: insertError } = await supabase
    .from('users')
    .insert({ clerk_id: userId })
    .select('id')
    .single();

  if (insertError) throw insertError;
  return created!.id as string;
}

export default getOrCreateInternalUserId;


