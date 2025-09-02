import { Router, type Request, type Response } from 'express';

const router = Router();

type AnalyzeBody = {
  image_base64?: string; // data without prefix
  locale?: string; // optional i18n
};

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

router.post('/api/analyze-nail', async (req: Request, res: Response) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
    }

    const body = req.body as AnalyzeBody;
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
        "care_tips": ["array of 2-3 simple, non-medical tips (e.g., moisturize cuticles, use strengthening polish)"],
        "notes": "short summary string with overall impression"
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
    let analysis: unknown;
    try {
      analysis = typeof content === 'string' ? JSON.parse(content) : content;
    } catch {
      analysis = { summary: 'Unable to parse result', issues: [], recommendations: [], confidence: 0 };
    }

    return res.json({ analysis });
  } catch (err) {
    return res.status(500).json({ error: 'Unexpected error' });
  }
});

export default router;


