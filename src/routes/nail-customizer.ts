import { Router, type Request, type Response } from 'express';
import { getAuth } from '@clerk/express';
import OpenAI, { toFile } from 'openai';

import getSupabase from '../utils/supabase.js';
import getOrCreateInternalUserId from '../utils/userLookup.js';

const router = Router();

type NailCustomizerBody = {
  image_base64?: string; // data without prefix
  colour?: string;
  shape?: string;
  length?: string;
  style?: string;
};

router.post('/api/nail-customizer', async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body as NailCustomizerBody;
  if (!body) return res.status(400).json({ error: 'Missing body' });

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });

  let imageBase64 = body.image_base64?.trim();

  if (!imageBase64) return res.status(400).json({ error: 'Provide image_base64' });
  
  // Guardrail: limit size (~5MB base64 => ~6.6MB data)
  if (imageBase64.length > 7_000_000) {
    return res.status(413).json({ error: 'Image too large' });
  }


  const prompt = `
    You are a professional Nail AI customizer.
    You will be provided with an image of a user's nails.
    You will need to customize the nails to user's desired styles.

    Please only customize the nails, do not change any other part of the image.

    The user's desired styles are:

    Colour: ${body.colour}
    Shape: ${body.shape}
    Length: ${body.length}
    Style: ${body.style}

    The response should be a JSON object with the following keys:

    {
      "image_base64": "base64-encoded-image"
    }
  `;


  const response = await client.images.edit({
    model: 'dall-e-2',
    image: null as any,
    prompt,
    n: 1,
    size: '1024x1024'
  })

  const image_base64 = response.data[0].b64_json;
  const image_bytes = Buffer.from(image_base64, 'base64');
  fs.writeFileSync('image.png', image_bytes);
});
