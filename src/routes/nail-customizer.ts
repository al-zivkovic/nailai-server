import { Router, type Request, type Response } from 'express';
import { getAuth } from '@clerk/express';
import crypto from 'crypto';

import getSupabase from '../utils/supabase.js';
import getOrCreateInternalUserId from '../utils/userLookup.js';
import { tryOnLimiter } from '../utils/rateLimit.js';

const router = Router();

type TryOnBody = {
  image_base64?: string; // data without prefix
  color?: string; // hex code
  colour?: string; // legacy support
  shape?: string; // Square, Round, Oval, Almond, Coffin, Stiletto, Ballerina
  length?: string; // Short, Medium, Long
  finish?: string; // Glossy, Matte, Satin
};

router.post('/api/try-on', tryOnLimiter, async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const envMock = String(process.env.MOCK_API).toLowerCase() === 'true';
    const mockParam = typeof req.query.mock === 'string' ? req.query.mock : '';
    const isMockRequest = (mockParam || '').toLowerCase() === 'true' || envMock;
    const body = req.body as TryOnBody | undefined;

    // Return immediately with a mock response when ?mock=true or MOCK_API=true
    if (isMockRequest) {
      // If a direct URL is provided, use it as-is to return an actual image without uploading
      const providedUrl = typeof req.query.url === 'string' ? req.query.url
        : (typeof req.query.mock_url === 'string' ? req.query.mock_url : '');
      if (providedUrl) {
        let storageBucket: string | null = null;
        let storagePath: string | null = null;
        try {
          const u = new URL(providedUrl);
          // Match common Supabase patterns:
          // - /storage/v1/object/sign/{bucket}/{path}
          // - /storage/v1/object/public/{bucket}/{path}
          const m = u.pathname.match(/\/storage\/v1\/object\/(sign|public)\/([^/]+)\/(.+)/);
          if (m) {
            storageBucket = m[2];
            storagePath = decodeURIComponent(m[3]);
          }
        } catch {
          // ignore URL parse errors; just return the image_url
        }
        return res.status(201).json({
          image_url: providedUrl,
          storage_bucket: storageBucket,
          storage_path: storagePath
        });
      }

      // Use provided image if present, otherwise upload a tiny placeholder PNG
      const placeholderPngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+9G9sAAAAASUVORK5CYII=';
      const inputBase64 = (body?.image_base64 ?? '').trim();
      const outputBuffer = inputBase64 && inputBase64.length <= 7_000_000
        ? Buffer.from(inputBase64, 'base64')
        : Buffer.from(placeholderPngBase64, 'base64');

      const supabase = getSupabase();
      const internalUserId = await getOrCreateInternalUserId(req);
      const bucket = 'try_on_images';

      // Ensure bucket exists (idempotent)
      const bucketInfo = await supabase.storage.getBucket(bucket);
      if (!bucketInfo.data) {
        await supabase.storage.createBucket(bucket, {
          public: false,
          fileSizeLimit: 10 * 1024 * 1024,
          allowedMimeTypes: ['image/png', 'image/jpeg']
        });
      }

      const objectPath = `${internalUserId}/${Date.now()}-${crypto.randomUUID()}.png`;
      const upload = await supabase.storage
        .from(bucket)
        .upload(objectPath, outputBuffer, { contentType: 'image/png', upsert: false });

      if (upload.error) return res.status(500).json({ error: 'Upload failed', detail: upload.error.message });

      const signedUrlRes = await supabase.storage
        .from(bucket)
        .createSignedUrl(objectPath, 60 * 60); // 1 hour

      if (signedUrlRes.error) return res.status(500).json({ error: 'Signed URL failed', detail: signedUrlRes.error.message });

      return res.status(201).json({
        image_url: signedUrlRes.data.signedUrl,
        storage_bucket: bucket,
        storage_path: objectPath
      });
    }   

    // TODO: Send an internal error message to the server that the OPENAI_API_KEY is not configured to prevent the client's awareness of the use of OpenAI
    // TODO: Client error message should be: "We're experiencing technical difficulties. Please try again later."
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
    }

    if (!body) return res.status(400).json({ error: 'Missing body' });

    const imageBase64 = body.image_base64?.trim();
    if (!imageBase64) return res.status(400).json({ error: 'Provide image_base64' });
    if (imageBase64.length > 7_000_000) {
      return res.status(413).json({ error: 'Image too large' });
    }

    // Validate style parameters
    const color = (body.color ?? body.colour ?? '').trim();
    const shape = (body.shape ?? '').trim();
    const length = (body.length ?? '').trim();
    const finish = (body.finish ?? '').trim();

    const validShapes = new Set(['square', 'round', 'oval', 'almond', 'coffin', 'stiletto', 'ballerina']);
    const validLengths = new Set(['short', 'medium', 'long']);
    const validFinishes = new Set(['glossy', 'matte', 'satin']);
    const hexColor = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;

    if (!hexColor.test(color)) return res.status(400).json({ error: 'Invalid color hex code' });
    if (!validShapes.has(shape.toLowerCase())) return res.status(400).json({ error: 'Invalid shape' });
    if (!validLengths.has(length.toLowerCase())) return res.status(400).json({ error: 'Invalid length' });
    if (!validFinishes.has(finish.toLowerCase())) return res.status(400).json({ error: 'Invalid finish' });

    const prompt = [
      'You are a professional nail retouching assistant.',
      'Given a photo of a hand with natural nails, adjust ONLY the nail areas to match the requested style.',
      'Do not modify skin tone, hand shape, background, lighting, or composition. Keep the image photorealistic.',
      `Apply: color ${color}, shape ${shape}, length ${length}, finish ${finish}.`,
      'Maintain the original pose and environment. Avoid artifacts like color spill or warped fingers.'
    ].join(' ');

    const inputBuffer = Buffer.from(imageBase64, 'base64');

    // Generate edited image via OpenAI Images API
    const form = new FormData();
    form.append('model', 'gpt-image-1');
    form.append('prompt', prompt);
    form.append('size', '1024x1024');
    form.append('n', '1');
    form.append('image', new Blob([inputBuffer], { type: 'image/png' }), 'input.png');

    const oaRes = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form
    });

    if (!oaRes.ok) {
      const detail = await oaRes.text().catch(() => 'OpenAI error');
      return res.status(502).json({ error: 'OpenAI request failed', detail });
    }

    const oaJson = await oaRes.json().catch(() => null) as any;
    const b64 = oaJson?.data?.[0]?.b64_json as string | undefined;
    if (!b64) return res.status(502).json({ error: 'Image generation failed' });
    const outputBuffer = Buffer.from(b64, 'base64');

    // Upload to Supabase Storage
    const supabase = getSupabase();
    const internalUserId = await getOrCreateInternalUserId(req);
    const bucket = 'try_on_images';

    // Ensure bucket exists (idempotent)
    const bucketInfo = await supabase.storage.getBucket(bucket);
    if (!bucketInfo.data) {
      await supabase.storage.createBucket(bucket, {
        public: false,
        fileSizeLimit: 10 * 1024 * 1024,
        allowedMimeTypes: ['image/png', 'image/jpeg']
      });
    }

    const objectPath = `${internalUserId}/${Date.now()}-${crypto.randomUUID()}.png`;
    const upload = await supabase.storage
      .from(bucket)
      .upload(objectPath, outputBuffer, { contentType: 'image/png', upsert: false });

    if (upload.error) return res.status(500).json({ error: 'Upload failed', detail: upload.error.message });

    const signedUrlRes = await supabase.storage
      .from(bucket)
      .createSignedUrl(objectPath, 60 * 60); // 1 hour

    if (signedUrlRes.error) return res.status(500).json({ error: 'Signed URL failed', detail: signedUrlRes.error.message });

    return res.status(201).json({
      image_url: signedUrlRes.data.signedUrl,
      storage_bucket: bucket,
      storage_path: objectPath
    });
  } catch (err) {
    return res.status(500).json({ error: 'Unexpected error' });
  }
});

type SaveLookBody = {
  image_url?: string;
  color?: string;
  colour?: string; // legacy alias
  shape?: string;
  length?: string;
  finish?: string;
  storage_bucket?: string | null;
  storage_path?: string | null;
  save?: boolean;
};

router.post('/api/try-on/save', async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const body = req.body as SaveLookBody | undefined;
    if (!body) return res.status(400).json({ error: 'Missing body' });

    // Allow a client-controlled "save" flag to opt-out early
    if (body.save === false) {
      return res.status(200).json({ saved: false });
    }

    const imageUrl = String(body.image_url ?? '').trim();
    const color = String(body.color ?? body.colour ?? '').trim();
    const shape = String(body.shape ?? '').trim();
    const length = String(body.length ?? '').trim();
    const finish = String(body.finish ?? '').trim();
    const storageBucket = body.storage_bucket ? String(body.storage_bucket).trim() : null;
    const storagePath = body.storage_path ? String(body.storage_path).trim() : null;

    if (!imageUrl) return res.status(400).json({ error: 'Missing image_url' });

    // Reuse the same validations as /api/try-on
    const validShapes = new Set(['square', 'round', 'oval', 'almond', 'coffin', 'stiletto', 'ballerina']);
    const validLengths = new Set(['short', 'medium', 'long']);
    const validFinishes = new Set(['glossy', 'matte', 'satin']);
    const hexColor = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;

    if (!hexColor.test(color)) return res.status(400).json({ error: 'Invalid color hex code' });
    if (!validShapes.has(shape.toLowerCase())) return res.status(400).json({ error: 'Invalid shape' });
    if (!validLengths.has(length.toLowerCase())) return res.status(400).json({ error: 'Invalid length' });
    if (!validFinishes.has(finish.toLowerCase())) return res.status(400).json({ error: 'Invalid finish' });

    const supabase = getSupabase();
    const internalUserId = await getOrCreateInternalUserId(req);

    // Check for an existing saved look to prevent duplicates
    // Prefer matching by storage bucket/path when present; otherwise by image_url
    let existing: any = null;
    if (storageBucket && storagePath) {
      const { data, error } = await supabase
        .from('saved_looks')
        .select('id')
        .eq('user_id', internalUserId)
        .eq('storage_bucket', storageBucket)
        .eq('storage_path', storagePath)
        .is('deleted_at', null)
        .limit(1);
      if (!error && Array.isArray(data) && data.length > 0) existing = data[0];
    }
    if (!existing) {
      const { data, error } = await supabase
        .from('saved_looks')
        .select('id')
        .eq('user_id', internalUserId)
        .eq('image_url', imageUrl)
        .is('deleted_at', null)
        .limit(1);
      if (!error && Array.isArray(data) && data.length > 0) existing = data[0];
    }

    if (existing) {
      return res.status(200).json({ saved: false, id: existing.id, reason: 'already_saved' });
    }

    const payload = {
      user_id: internalUserId,
      image_url: imageUrl,
      color,
      shape,
      length,
      finish,
      storage_bucket: storageBucket,
      storage_path: storagePath
    };

    const { data, error } = await supabase
      .from('saved_looks')
      .insert(payload)
      .select('id, inserted_at')
      .single();

    if (error) return res.status(400).json({ error: (error as any)?.message ?? 'Unknown error' });

    return res.status(201).json({ saved: true, id: data?.id ?? null, inserted_at: data?.inserted_at ?? null });
  } catch (err) {
    return res.status(500).json({ error: 'Unexpected error' });
  }
})

// List saved looks (default limit 10)
router.get('/api/saved-looks', async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const supabase = getSupabase();
    const internalUserId = await getOrCreateInternalUserId(req);

    const limitParam = Number(req.query.limit ?? 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 50 ? Math.floor(limitParam) : 10;

    const { data, error } = await supabase
      .from('saved_looks')
      .select('id, inserted_at, image_url, storage_bucket, storage_path, color, shape, length, finish')
      .eq('user_id', internalUserId)
      .is('deleted_at', null)
      .order('inserted_at', { ascending: false })
      .limit(limit);

    if (error) return res.status(400).json({ error: (error as any)?.message ?? 'Unknown error' });

    const rows = Array.isArray(data) ? data : [];
    const signed = await Promise.all(rows.map(async (row: any) => {
      const bucket = row.storage_bucket as string | null | undefined;
      const path = row.storage_path as string | null | undefined;
      if (bucket && path) {
        const signedRes = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60);
        const url = signedRes.data?.signedUrl ?? row.image_url;
        return { ...row, image_url: url };
      }
      return row;
    }));

    return res.status(200).json({ looks: signed });
  } catch (err) {
    return res.status(500).json({ error: 'Unexpected error' });
  }
});

// Get a specific saved look by id
router.get('/api/saved-looks/:id', async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const supabase = getSupabase();
    const internalUserId = await getOrCreateInternalUserId(req);
    const id = String(req.params.id ?? '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const { data, error } = await supabase
      .from('saved_looks')
      .select('*')
      .eq('user_id', internalUserId)
      .eq('id', id)
      .is('deleted_at', null)
      .single();

    if (error?.code === 'PGRST116' || !data) return res.status(404).json({ error: 'Not found' });
    if (error) return res.status(400).json({ error: (error as any)?.message ?? 'Unknown error' });

    let imageUrl = data.image_url as string | null;
    if (data.storage_bucket && data.storage_path) {
      const signedRes = await supabase.storage
        .from(data.storage_bucket as string)
        .createSignedUrl(data.storage_path as string, 60 * 60);
      imageUrl = signedRes.data?.signedUrl ?? imageUrl;
    }

    return res.status(200).json({
      look: {
        ...data,
        image_url: imageUrl
      }
    });
  } catch (err) {
    return res.status(500).json({ error: 'Unexpected error' });
  }
});

// Delete a saved look (soft delete)
router.delete('/api/saved-looks/:id', async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const id = String(req.params.id ?? '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const supabase = getSupabase();
    const internalUserId = await getOrCreateInternalUserId(req);

    const { data, error } = await supabase
      .from('saved_looks')
      .update({ deleted_at: new Date().toISOString() })
      .eq('user_id', internalUserId)
      .eq('id', id)
      .is('deleted_at', null)
      .select('id')
      .single();

    if (error?.code === 'PGRST116' || !data) return res.status(404).json({ error: 'Not found' });
    if (error) return res.status(400).json({ error: (error as any)?.message ?? 'Unknown error' });

    return res.status(200).json({ deleted: true, id: data.id });
  } catch (err) {
    return res.status(500).json({ error: 'Unexpected error' });
  }
});

export default router;

