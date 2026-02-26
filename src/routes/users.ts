import { Router, type Request, type Response } from 'express';
import { getAuth } from '@clerk/express';
import getSupabase from '../utils/supabase.js';

const router = Router();

type CreateUserBody = {
  email?: string;
  first_name?: string | null;
  last_name?: string | null;
};

router.post('/api/users/sign-up', async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const body = req.body as CreateUserBody | undefined;
    if (!body?.email) return res.status(400).json({ error: 'email is required' });

    const payload = {
      clerk_id: userId,
      email: body.email,
      first_name: body.first_name ?? null,
      last_name: body.last_name ?? null
    };

    const { data, error } = await getSupabase()
      .from('users')
      .insert(payload)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    return res.status(201).json({ user: data });
  } catch (err) {
    console.error('Error in /api/users/sign-up:', err);
    console.error('Stack:', err instanceof Error ? err.stack : 'No stack trace');
    return res.status(500).json({ 
      error: 'Unexpected error',
      message: process.env.NODE_ENV === 'production' ? undefined : (err instanceof Error ? err.message : String(err))
    });
  }
});

export default router;


