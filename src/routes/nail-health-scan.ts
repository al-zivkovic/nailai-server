import { Router, type Request, type Response } from 'express';
import { getAuth } from '@clerk/express';
import getSupabase from '../utils/supabase.js';
import getOrCreateInternalUserId from '../utils/userLookup.js';

const router = Router();

type NailHealthScanBody = {
  image_base64?: string; // data without prefix
  locale?: string; // optional i18n
};

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

router.post('/api/nail-health-scan', async (req: Request, res: Response) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
    }

    const body = req.body as NailHealthScanBody;
    if (!body) return res.status(400).json({ error: 'Missing body' });

    let imageBase64 = body.image_base64?.trim();

    if (!imageBase64) return res.status(400).json({ error: 'Provide image_base64' });

    // Guardrail: limit size (~5MB base64 => ~6.6MB data)
    if (imageBase64.length > 7_000_000) {
      return res.status(413).json({ error: 'Image too large' });
    }

    const prompt = `
      You are a professional Nail AI health and beauty assistant.
      You are providing a detailed analysis of a user's nail health and beauty.
      Do NOT provide medical diagnoses. Focus only on cosmetic nail health and style insights.

      The response should be a JSON object with the following keys:

      {
        "recommended_length": "short | medium | long",
        "natural_shape": "square | round | oval | almond | coffin | stiletto | wide | narrow",
        "cuticle_health": "healthy | dry | inflamed | overgrown",
        "cuticle_health_score": 0..100,
        "nail_strength": "normal | brittle | peeling",
        "nail_strength_score": 0..100,
        "hydration": "normal | dry | hydrated",
        "hydration_score": 0..100,
        "staining": "normal | staining | discolored",
        "staining_score": 0..100,
        "recommended_styles": ["array of 2-3 recommended nail shapes/styles based on their natural nails"],
        "recommended_color": "array of 2-3 recommended nail colors based on their natural nails",
        "recommended_products": ["array of 2-3 recommended products based on the analysis"],
        "care_tips": ["array of 2-3 simple, non-medical tips (e.g., moisturize cuticles, use strengthening polish)"],
        "notes": "short summary string with overall impression"
      }

      Consider the following:
      - If the images are not of a person's nails, you should return:
      {
        "notes": "Please provide an image of your nails."
      }
    `;

    const oaRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a careful, non-diagnostic nail health assistant. You are not a medical professional. Respond in JSON only.' },
          { role: 'user', content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
          ]}
        ]
      })
    });

    if (!oaRes.ok) {
      const text = await oaRes.text().catch(() => 'OpenAI error');
      return res.status(502).json({ error: 'OpenAI request failed', detail: text });
    }
    type ChatCompletion = { choices?: Array<{ message?: { content?: string } }> };
    const json = (await oaRes.json()) as ChatCompletion;
    const content = json.choices?.[0]?.message?.content ?? '{}';

    // content should be a JSON string because of response_format
    let analysis: any;
    try {
      analysis = typeof content === 'string' ? JSON.parse(content) : content;
    } catch {
      analysis = { summary: 'Unable to parse result', issues: [], recommendations: [], confidence: 0 };
    }

    // If model indicates non-nail image, don't insert; return simple JSON
    const pleaseProvideBase = 'Please provide an image of your nails';
    const normalize = (s: string) => s.trim().replace(/\.$/, '');
    if (
      (typeof analysis === 'string' && normalize(analysis) === pleaseProvideBase) ||
      (typeof analysis?.notes === 'string' && normalize(analysis.notes) === pleaseProvideBase)
    ) {
      return res.status(422).json({ error: 'not_nail_image', message: pleaseProvideBase });
    }

    // Insert into DB
    const internalUserId = await getOrCreateInternalUserId(req);

    const payload = {
      user_id: internalUserId,
      recommended_length: analysis?.recommended_length ?? null,
      natural_shape: analysis?.natural_shape ?? null,
      cuticle_health: analysis?.cuticle_health ?? null,
      cuticle_health_score: analysis?.cuticle_health_score ?? null,
      nail_strength: analysis?.nail_strength ?? null,
      nail_strength_score: analysis?.nail_strength_score ?? null,
      hydration: analysis?.hydration ?? null,
      hydration_score: analysis?.hydration_score ?? null,
      staining: analysis?.staining ?? null,
      staining_score: analysis?.staining_score ?? null,
      recommended_styles: Array.isArray(analysis?.recommended_styles) ? analysis.recommended_styles : null,
      recommended_colors: Array.isArray(analysis?.recommended_colors) ? analysis.recommended_colors : null,
      recommended_products: Array.isArray(analysis?.recommended_products) ? analysis.recommended_products : null,
      care_tips: Array.isArray(analysis?.care_tips) ? analysis.care_tips : null,
      notes: typeof analysis?.notes === 'string' ? analysis.notes : null,
      raw_json: analysis ?? null
    };

    const { data, error } = await getSupabase()
      .from('nail_health_scans')
      .insert(payload)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message, analysis });

    return res.status(201).json({ analysis, record: data });
  } catch (err) {
    return res.status(500).json({ error: 'Unexpected error' });
  }
});

router.get('/api/nail-health-scan/latest', async (req: Request, res: Response) => {
  const { userId } = getAuth(req);

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { data, error } = await getSupabase()
    .from('nail_health_scans')
    .select('*')
    .eq('user_id', (await getOrCreateInternalUserId(req)))
    .order('inserted_at', { ascending: false })
    .limit(1);

  if (error) return res.status(400).json({ error: error.message });

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return res.status(200).json({ analysis: null });

  const analysis = {
    recommended_length: row.recommended_length ?? null,
    natural_shape: row.natural_shape ?? null,
    cuticle_health: row.cuticle_health ?? null,
    cuticle_health_score: row.cuticle_health_score ?? null,
    nail_strength: row.nail_strength ?? null,
    nail_strength_score: row.nail_strength_score ?? null,
    hydration: row.hydration ?? null,
    hydration_score: row.hydration_score ?? null,
    staining: row.staining ?? null,
    staining_score: row.staining_score ?? null,
    recommended_styles: row.recommended_styles ?? null,
    recommended_colors: row.recommended_colors ?? null,
    recommended_products: row.recommended_products ?? null,
    care_tips: row.care_tips ?? null,
    notes: row.notes ?? null,
  };

  return res.status(200).json({ analysis });
});

export default router;


