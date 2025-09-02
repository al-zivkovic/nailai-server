import { Router, type Request, type Response } from 'express';
import { getAuth } from '@clerk/express';
import supabase from '../utils/supabase.js';

const router = Router();

type CreateUserBody = {
  email?: string;
  first_name?: string | null;
  last_name?: string | null;
};

router.post('/api/users', async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const body = req.body as CreateUserBody | undefined;
    if (!body?.email) return res.status(400).json({ error: 'email is required' });

    const payload = {
      user_clerk_id: userId,
      email: body.email,
      first_name: body.first_name ?? null,
      last_name: body.last_name ?? null
    };

    const { data, error } = await supabase
      .from('users')
      .insert(payload)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    return res.status(201).json({ user: data });
  } catch (err) {
    return res.status(500).json({ error: 'Unexpected error' });
  }
});

export default router;


