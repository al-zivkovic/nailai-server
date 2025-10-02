import { Router, type Request, type Response } from 'express';
import { getAuth } from '@clerk/express';
import crypto from 'crypto';

import getSupabase from '../utils/supabase.js';
import getOrCreateInternalUserId from '../utils/userLookup.js';

const router = Router();

type TryOnBody = {
  image_base64?: string; // data without prefix
  color?: string; // hex code
  colour?: string; // legacy support
  shape?: string; // Square, Round, Oval, Almond, Coffin, Stiletto, Ballerina
  length?: string; // Short, Medium, Long
  finish?: string; // Glossy, Matte, Satin
};

router.post('/api/try-on', async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // TODO: Send an internal error message to the server that the OPENAI_API_KEY is not configured to prevent the client's awareness of the use of OpenAI 
    // TODO: Client error message should be: "We're experiencing technical difficulties. Please try again later."
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
    }

    const body = req.body as TryOnBody | undefined;
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

export default router;
