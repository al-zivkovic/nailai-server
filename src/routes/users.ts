import { Router, type Request, type Response } from 'express';
import { getAuth, clerkClient } from '@clerk/express';
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

/**
 * DELETE /api/users/me
 *
 * Permanently deletes the authenticated user's account and all associated
 * personal data. Required by App Store Review Guideline 5.1.1(v) for apps
 * that support account creation, and satisfies GDPR/CCPA "right to erasure"
 * requests.
 *
 * Deletion order:
 *   1. Remove Supabase Storage objects referenced by saved_looks (best-effort).
 *   2. Hard-delete child rows (saved_looks, nail_health_scans). Subscription
 *      state lives on `users.is_subscribed` and is sourced from Superwall, so
 *      there's no separate subscriptions table to clean.
 *   3. Hard-delete the users row.
 *   4. Delete the Clerk user (best-effort — if it fails, the app DB is still
 *      clean and the client will sign the user out).
 *
 * The endpoint is idempotent: calling it for a user with no DB row still
 * attempts to delete the Clerk user and returns success.
 */
router.delete('/api/users/me', async (req: Request, res: Response) => {
  // Hoisted so it remains accessible after the user-row branch closes.
  const childWarnings: string[] = [];
  try {
    const { userId: clerkUserId } = getAuth(req);
    if (!clerkUserId) return res.status(401).json({ error: 'Unauthorized' });

    const supabase = getSupabase();

    const { data: userRow, error: selectError } = await supabase
      .from('users')
      .select('id')
      .eq('clerk_id', clerkUserId)
      .maybeSingle();

    if (selectError) {
      console.error('users/me DELETE lookup error:', selectError);
      return res.status(500).json({ error: 'Failed to look up user' });
    }

    if (userRow) {
      const userUuid = userRow.id as string;

      // 1. Best-effort removal of Storage objects referenced by saved_looks.
      //    Group by bucket so we can batch the remove() calls.
      const { data: looks, error: looksError } = await supabase
        .from('saved_looks')
        .select('storage_bucket, storage_path')
        .eq('user_id', userUuid);

      if (looksError) {
        console.warn('users/me DELETE: failed to list saved_looks for storage cleanup:', looksError);
      } else if (looks?.length) {
        const byBucket = new Map<string, string[]>();
        for (const l of looks) {
          if (l.storage_bucket && l.storage_path) {
            const bucket = l.storage_bucket as string;
            const path = l.storage_path as string;
            const list = byBucket.get(bucket) ?? [];
            list.push(path);
            byBucket.set(bucket, list);
          }
        }
        for (const [bucket, paths] of byBucket.entries()) {
          const { error: storageError } = await supabase.storage.from(bucket).remove(paths);
          if (storageError) {
            console.warn(`users/me DELETE: failed to remove ${paths.length} object(s) from bucket ${bucket}:`, storageError);
          }
        }
      }

      // 2. Hard-delete child rows. Best-effort: a failure on one child
      //    table (e.g. a schema drift or RLS policy) shouldn't block
      //    the deletion of the user's actual content or the user row
      //    itself. Failures are logged loudly and surfaced in the
      //    response so an operator can investigate, but the request
      //    still returns success once the user row + their personal
      //    content are gone.
      //
      //    NOTE: there's a `subscriptions` migration in supabase/migrations
      //    that was never applied — the Superwall webhook flips
      //    `users.is_subscribed` directly instead. If you later resurrect
      //    that table (apply the migration + start inserting rows), add
      //    `'subscriptions'` to the array below so deleted users don't
      //    leave orphaned rows.
      const childTables = ['saved_looks', 'nail_health_scans'] as const;
      for (const table of childTables) {
        const { error } = await supabase.from(table).delete().eq('user_id', userUuid);
        if (error) {
          console.error(`users/me DELETE: failed to delete ${table}:`, error);
          childWarnings.push(`${table}: ${error.message}`);
        }
      }

      // 3. Hard-delete the user row itself.
      const { error: userDeleteError } = await supabase
        .from('users')
        .delete()
        .eq('id', userUuid);

      if (userDeleteError) {
        console.error('users/me DELETE: failed to delete user row:', userDeleteError);
        return res.status(500).json({ error: 'Failed to delete user record' });
      }
    }

    // 4. Delete the Clerk user. We treat this as best-effort because the
    //    most important compliance step (removing personal data from our
    //    own systems) has already completed. If this fails the client will
    //    still be signed out, and we log loudly so the operator can clean
    //    up the orphan Clerk record manually.
    try {
      await clerkClient.users.deleteUser(clerkUserId);
    } catch (err) {
      console.error('users/me DELETE: failed to delete Clerk user — manual cleanup required:', err);
    }

    // Surface non-fatal child-table cleanup warnings so the operator
    // (and any QA harness) can see them without grepping logs.
    return res.status(200).json({
      deleted: true,
      ...(childWarnings.length ? { warnings: childWarnings } : {}),
    });
  } catch (err) {
    console.error('Error in DELETE /api/users/me:', err);
    return res.status(500).json({
      error: 'Unexpected error',
      message: process.env.NODE_ENV === 'production' ? undefined : (err instanceof Error ? err.message : String(err)),
    });
  }
});

export default router;
