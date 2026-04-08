import { Router, type Request, type Response } from 'express';
import { getAuth } from '@clerk/express';
import getSupabase from '../utils/supabase.js';

const router = Router();

type EnsureUserBody = {
  email?: string;
  first_name?: string | null;
  last_name?: string | null;
};

router.post('/api/users/ensure', async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const body = req.body as EnsureUserBody | undefined;
    const supabase = getSupabase();

    const { data: existing, error: selectError } = await supabase
      .from('users')
      .select('*')
      .eq('clerk_id', userId)
      .maybeSingle();

    if (selectError) {
      console.error('users/ensure SELECT error:', selectError);
      return res.status(400).json({ error: selectError.message });
    }

    if (existing) {
      const updates: Record<string, any> = { updated_at: new Date().toISOString() };
      if (body?.email) updates.email = body.email;
      if (body?.first_name !== undefined) updates.first_name = body.first_name;
      if (body?.last_name !== undefined) updates.last_name = body.last_name;

      await supabase.from('users').update(updates).eq('id', existing.id);

      return res.status(200).json({
        user: { ...existing, ...updates },
        is_new: false,
        is_subscribed: existing.is_subscribed ?? false,
      });
    }

    if (!body?.email) {
      return res.status(400).json({ error: 'email is required for new users' });
    }

    const { data: newUser, error: upsertError } = await supabase
      .from('users')
      .upsert(
        {
          clerk_id: userId,
          email: body.email,
          first_name: body.first_name ?? null,
          last_name: body.last_name ?? null,
          is_subscribed: false,
        },
        { onConflict: 'clerk_id' }
      )
      .select()
      .single();

    if (upsertError) return res.status(400).json({ error: upsertError.message });

    return res.status(201).json({
      user: newUser,
      is_new: true,
      is_subscribed: false,
    });
  } catch (err) {
    console.error('Error in /api/users/ensure:', err);
    return res.status(500).json({
      error: 'Unexpected error',
      message: process.env.NODE_ENV === 'production' ? undefined : (err instanceof Error ? err.message : String(err)),
    });
  }
});

export default router;
