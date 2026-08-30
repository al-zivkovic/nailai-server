import sharp from 'sharp';

/**
 * Bounding box for one fingernail in normalized [0..1] image coordinates.
 * (0, 0) is top-left of the image; (1, 1) is bottom-right.
 */
export type NailBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * A single user-tapped point identifying the centre of a fingernail.
 * Coordinates are normalized to [0..1] in the image being processed.
 */
export type NailPoint = {
  x: number;
  y: number;
};

/**
 * Convert user-tapped centre points into nail bounding boxes.
 *
 * The user can't easily tell us how big each nail is, so we estimate
 * size from the spread of their taps: tighter clusters mean a closer
 * hand → bigger nails, wider spreads → smaller nails. Single-point
 * taps fall back to a sensible default.
 *
 * Empirical calibration: nail width is roughly half the average inter-
 * point distance, with a clamp to avoid pathological extremes
 * (e.g. all five taps at the same pixel, or one tap in opposite
 * corners of the frame).
 */
export function pointsToBoxes(points: NailPoint[]): NailBox[] {
  if (points.length === 0) return [];

  let totalDist = 0;
  let pairCount = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[i].x - points[j].x;
      const dy = points[i].y - points[j].y;
      totalDist += Math.sqrt(dx * dx + dy * dy);
      pairCount++;
    }
  }
  // 0.15 fallback ≈ a hand at moderate distance occupies the centre of
  // the frame; nails would be ~5% of image height.
  const avgDist = pairCount > 0 ? totalDist / pairCount : 0.15;

  // Bumped from 0.5×avgDist (range 0.04–0.10) to 0.6×avgDist (range
  // 0.06–0.13) after we observed the natural nail's edges still
  // peeking past the painted region in tests. Slightly oversized is
  // strictly better than slightly undersized — the feathered composite
  // hides any extra edit area, but undersized leaves visible halos of
  // the original nail.
  const nailWidth = Math.max(0.06, Math.min(0.13, avgDist * 0.6));
  const nailHeight = nailWidth * 1.3;

  return points.map((p) => {
    const x = Math.max(0, p.x - nailWidth / 2);
    const y = Math.max(0, p.y - nailHeight / 2);
    return {
      x,
      y,
      width: Math.min(nailWidth, 1 - x),
      height: Math.min(nailHeight, 1 - y),
    };
  });
}

const DETECTION_SYSTEM_PROMPT = `You are a precise computer-vision assistant that localizes fingernails on human hands.

Process:
  1. First, look at the image and decide whether there is a clearly visible HUMAN HAND.
  2. If yes, locate the bounding boxes of fingernails ON THAT HAND ONLY.
  3. If no hand is visible, set hand_visible to false and return an empty array.

A fingernail is the keratinous plate at the tip of a human finger. It is NOT:
  - A rectangular UI element on a computer or phone screen
  - A button, icon, key on a keyboard, or other decoration
  - A code-editor block or text region that merely happens to be nail-shaped
  - Any rectangle that is not physically attached to a human finger
  - Anything outside the bounds of the visible hand

Strict requirements for boxes you DO return:
  - Coordinates are normalized to [0, 1], with (0, 0) at top-left.
  - Each box must enclose ONLY the visible nail surface — not the surrounding skin, finger pad, or cuticle.
  - Include only nails that are in focus and large enough to be visibly painted.
  - A real human hand has 1–5 visible nails. Do not invent nails to reach 5.
  - All returned boxes should be on the SAME hand (a typical hand spans roughly a quarter to three-quarters of the frame).

Be conservative: it is better to miss a real nail than to invent one. When in doubt, omit the box.`;

const DETECTION_USER_PROMPT =
  'Look at this image. Is there a clearly visible human hand? If yes, locate the visible fingernails on it and return tight bounding boxes around each one. Do not include rectangular shapes that are not actual fingernails on a finger.';

const DETECTION_SCHEMA = {
  name: 'nail_detections',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      hand_visible: {
        type: 'boolean',
        description: 'Whether a clearly visible human hand is present in the image.',
      },
      reasoning: {
        type: 'string',
        description: 'One short sentence describing what the image shows. Used for debugging.',
      },
      nails: {
        type: 'array',
        description: 'One bounding box per visible fingernail on the visible hand. Empty if no hand is visible.',
        items: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'Left edge, normalized [0..1].' },
            y: { type: 'number', description: 'Top edge, normalized [0..1].' },
            width: { type: 'number', description: 'Width, normalized [0..1].' },
            height: { type: 'number', description: 'Height, normalized [0..1].' },
          },
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false,
        },
      },
    },
    required: ['hand_visible', 'reasoning', 'nails'],
    additionalProperties: false,
  },
};

/**
 * Validate a single raw box from the model. Returns a clamped NailBox
 * if the box is plausible, otherwise null.
 *
 * "Plausible" means: numeric, non-degenerate, fits within the image,
 * and doesn't claim to cover an absurdly large region (a real
 * fingernail is at most ~25% of the frame even in extreme close-ups).
 */
function validateBox(raw: unknown): NailBox | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const x = Number(r.x);
  const y = Number(r.y);
  const width = Number(r.width);
  const height = Number(r.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  if (x < 0 || y < 0) return null;
  if (width <= 0 || height <= 0) return null;
  // Allow a tiny slack for rounding, then clamp.
  if (x + width > 1.05 || y + height > 1.05) return null;
  if (width > 0.4 || height > 0.4) return null;
  const cx = Math.max(0, x);
  const cy = Math.max(0, y);
  return {
    x: cx,
    y: cy,
    width: Math.min(width, 1 - cx),
    height: Math.min(height, 1 - cy),
  };
}

/**
 * Call GPT-4o vision to locate the visible fingernails in `imagePngBase64`.
 *
 * Returns an array of normalized bounding boxes, or `null` if no nails
 * could be detected (caller should surface a `not_nail_image` 422).
 *
 * Cost: ~$0.005 per call (one ~1024px image input + ~50 output tokens).
 * Latency: typically 1–3s.
 */
export async function detectNailRegions(imagePngBase64: string): Promise<NailBox[] | null> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      // Strict structured output: model must return exactly { nails: [...] }
      // matching DETECTION_SCHEMA. Catches malformed responses at the API
      // level rather than us hand-parsing.
      response_format: {
        type: 'json_schema',
        json_schema: DETECTION_SCHEMA,
      },
      messages: [
        { role: 'system', content: DETECTION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: DETECTION_USER_PROMPT },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${imagePngBase64}`, detail: 'high' },
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('[nailMask] vision detection failed:', res.status, detail);
    return null;
  }

  const json = (await res.json().catch(() => null)) as any;
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    console.warn('[nailMask] vision returned no content');
    return null;
  }

  let parsed: { hand_visible?: unknown; reasoning?: unknown; nails?: unknown };
  try {
    parsed = JSON.parse(content);
  } catch {
    console.warn('[nailMask] vision returned non-JSON content');
    return null;
  }

  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';
  const handVisible = parsed.hand_visible === true;
  console.log(`[nailMask] vision: hand_visible=${handVisible} reasoning="${reasoning}"`);

  if (!handVisible) return null;

  const raw = parsed.nails;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const valid: NailBox[] = [];
  for (const item of raw) {
    const box = validateBox(item);
    if (box) valid.push(box);
  }

  if (valid.length === 0) return null;
  // Defensive cap: a human has 10 fingers. If we get more than 12 boxes
  // back, something is wrong with detection — bail rather than build a
  // mask peppered with fake nails.
  if (valid.length > 12) {
    console.warn(`[nailMask] detection returned ${valid.length} boxes — capping as failure`);
    return null;
  }

  // Cluster sanity check: all returned nails should fit within a single
  // hand-sized region. Compute the union bounding box of every detection
  // and reject if it spans more than 80% of the frame in either axis,
  // which would imply boxes scattered across the image (e.g. one on the
  // hand, several on the laptop screen behind it).
  if (valid.length >= 2) {
    const minX = Math.min(...valid.map((b) => b.x));
    const minY = Math.min(...valid.map((b) => b.y));
    const maxX = Math.max(...valid.map((b) => b.x + b.width));
    const maxY = Math.max(...valid.map((b) => b.y + b.height));
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    if (spanX > 0.8 || spanY > 0.8) {
      console.warn(
        `[nailMask] cluster sanity: boxes span ${spanX.toFixed(2)}x${spanY.toFixed(2)} of frame — rejecting`,
      );
      return null;
    }
  }

  return valid;
}

/**
 * Generate an inpainting mask PNG matching the input image's dimensions.
 *
 * The mask is fully opaque ("preserve this pixel") everywhere except for
 * the supplied bounding boxes, which are transparent ("the model may
 * regenerate this pixel"). OpenAI's `/v1/images/edits` endpoint requires
 * the mask to match the input image dimensions exactly.
 *
 * `paddingPct` adds a margin around each box, expressed as a fraction
 * of the box's own size. Useful because the vision model's boxes hug
 * the nail tightly; a small pad gives the edit a few pixels of skin
 * border to blend cleanly into.
 */
export async function buildNailMask(
  width: number,
  height: number,
  boxes: NailBox[],
  paddingPct: number = 0.25,
): Promise<Buffer> {
  // Generous padding (25% by default — was 12%). Slightly oversized
  // edit zones are fine because the feathered composite hides any
  // overspill, but undersized ones leave bits of the original nail
  // visible at the corners. Better to lean big.
  const padded = boxes.map((b) => {
    const padX = b.width * paddingPct;
    const padY = b.height * paddingPct;
    const x = Math.max(0, b.x - padX);
    const y = Math.max(0, b.y - padY);
    return {
      x,
      y,
      width: Math.min(1 - x, b.width + 2 * padX),
      height: Math.min(1 - y, b.height + 2 * padY),
    };
  });

  // SVG ellipses (was rectangles). Nails are oval/curved, not square,
  // and the rectangular outlines were clearly visible in test outputs.
  // An ellipse inscribed in the same bounding box is shaped like a
  // nail and gives the AI a more natural region to paint into. We
  // also still feather the result in compositeNailEdit so any residual
  // hard edge softens away.
  const ellipses = padded
    .map((b) => {
      const cx = (b.x + b.width / 2) * width;
      const cy = (b.y + b.height / 2) * height;
      const rx = (b.width / 2) * width;
      const ry = (b.height / 2) * height;
      return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="black"/>`;
    })
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${ellipses}</svg>`;

  const base = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 }, // fully opaque
    },
  });

  return base
    .composite([{ input: Buffer.from(svg), blend: 'dest-out' }])
    .png()
    .toBuffer();
}

/**
 * Pick the closest gpt-image-1 supported output size for a given input
 * aspect ratio. The chosen size is also what we resize the input to so
 * that the input image, mask, and output all share identical dimensions
 * (avoids surprise cropping by the API).
 */
export function pickTargetSize(width: number, height: number): {
  sizeParam: '1024x1024' | '1024x1536' | '1536x1024';
  width: number;
  height: number;
} {
  const aspect = width / height;
  if (aspect > 1.2) return { sizeParam: '1536x1024', width: 1536, height: 1024 };
  if (aspect < 1 / 1.2) return { sizeParam: '1024x1536', width: 1024, height: 1536 };
  return { sizeParam: '1024x1024', width: 1024, height: 1024 };
}

/**
 * Pixel-perfect compositing of the AI-edited image onto the original.
 *
 * Why this is necessary: gpt-image-1 with /v1/images/edits and a mask is
 * documented to "only modify pixels in the transparent region", but in
 * practice the model still subtly redraws the entire canvas — text in
 * the background, fine detail in skin, etc. all drift. To guarantee
 * bit-for-bit preservation outside the nail regions, we manually
 * composite: take the AI output, keep only the pixels that fall inside
 * the mask's transparent zones, and overlay onto the original.
 *
 * Mechanics with sharp's `dest-out` blend mode:
 *   ai-output ⨉ mask  →  ai-output where mask is transparent (i.e. nail
 *                         regions), transparent everywhere else.
 *   Then over the original → original visible everywhere except the
 *                         nail regions, which show the AI's painting.
 */
export async function compositeNailEdit(
  originalPng: Buffer,
  aiOutputPng: Buffer,
  maskPng: Buffer,
  featherPx: number = 8,
): Promise<Buffer> {
  // Soften the mask with a Gaussian blur before compositing. The mask
  // we feed OpenAI is a hard binary alpha (so the model has a clear
  // "edit here" boundary), but for OUR composite step we want a gentle
  // gradient: the AI's painted nail should fade smoothly into the
  // surrounding skin instead of cutting off at a sharp edge. The blur
  // turns the mask's edges into a soft alpha ramp; through `dest-out`
  // composite, that becomes a smooth blend in the final image.
  //
  // Sigma calibration: ~8px gives a 16–24px blend zone at our typical
  // 1024–1536px image sizes, which is roughly the width of a nail
  // boundary. Tune up for softer transitions, down for crisper edges.
  const softMask = featherPx > 0
    ? await sharp(maskPng).blur(featherPx).png().toBuffer()
    : maskPng;

  // Step 1: punch the mask's opaque areas out of the AI output, leaving
  // only the nail-region pixels visible (with a soft alpha gradient at
  // the boundary, courtesy of the feathered mask).
  const aiNailsOnly = await sharp(aiOutputPng)
    .composite([{ input: softMask, blend: 'dest-out' }])
    .png()
    .toBuffer();

  // Step 2: lay those nail pixels on top of the original. Outside the
  // nail regions the original is fully visible; inside, the AI's
  // painting blends in via the gradient.
  return sharp(originalPng)
    .composite([{ input: aiNailsOnly, blend: 'over' }])
    .png()
    .toBuffer();
}

/**
 * Convert any input image buffer to a PNG, preserving its aspect ratio
 * and dimensions (with a defensive scale-down for unreasonably huge
 * images). The client is responsible for cover-cropping to one of
 * gpt-image-1's supported aspects (1:1, 2:3, 3:2) BEFORE sending — that
 * keeps the user's tap-point coordinates valid through to here without
 * needing any geometric retransformation server-side.
 *
 * Returns the PNG, the actual dimensions, and the closest gpt-image-1
 * `size` parameter for the OpenAI request.
 */
export async function normalizeInputImage(rawBuffer: Buffer): Promise<{
  png: Buffer;
  width: number;
  height: number;
  sizeParam: '1024x1024' | '1024x1536' | '1536x1024';
}> {
  const meta = await sharp(rawBuffer).metadata();
  if (!meta.width || !meta.height) {
    throw new Error('Could not read input image dimensions');
  }
  // Defensive cap. Client should already be sending ≤1536, but if a
  // raw 4032px iPhone shot arrives we resize down to keep payloads to
  // OpenAI bounded.
  const MAX_DIM = 2048;
  let width = meta.width;
  let height = meta.height;
  let png: Buffer;
  if (Math.max(width, height) > MAX_DIM) {
    const scale = MAX_DIM / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
    png = await sharp(rawBuffer).resize(width, height).png().toBuffer();
  } else {
    png = await sharp(rawBuffer).png().toBuffer();
  }
  const target = pickTargetSize(width, height);
  return { png, width, height, sizeParam: target.sizeParam };
}
