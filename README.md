# nailai-server

Minimal Node.js + Express server in TypeScript.

## Scripts

- dev: start in watch mode
- build: compile TypeScript to `dist`
- start: run compiled server
- lint: run ESLint

## Quickstart

```bash
npm install
npm run dev
# Server listening on http://localhost:3001
```

## Environment

- `PORT` (default 3001)
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (required for auth middleware)
- `OPENAI_API_KEY` (required for analyze route)
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (required for rate limiting)
  - Dev: you can skip these locally by setting `DISABLE_RATE_LIMIT=true`

## Endpoints

- `GET /health` → `{ ok: true, env: "development|production" }`
- `GET /` → health text
- `GET /api/me` → requires `Authorization: Bearer <supabase_jwt>`; returns `{ user }`
 - `POST /api/analyze-nail` → requires `Authorization: Bearer <supabase_jwt>`
   - body: `{ image_base64: string }` or `{ storage_bucket: string, storage_path: string }`
   - returns: `{ analysis: { summary, issues[], recommendations[], confidence } }`

## Local Supabase Development
1. Install Docker


## Rate limiting

The following per-user limits are enforced using Upstash Redis (sliding window):

- `POST /api/try-on`
  - 2 requests per minute
  - 20 requests per day (fair use cap)

- `POST /api/nail-health-scan`
  - 3 requests per minute
  - 30 requests per hour
  - 50 requests per day (fair use cap)

If a limit is exceeded, the server responds with HTTP 429 and JSON:

```json
{
  "error": "rate_limited",
  "limits": { "perMinute": 2, "perDay": 20 },
  "detail": [
    { "scope": "minute", "success": false, "reset": 1720000000, "remaining": 0 }
  ]
}
```

Environment variables required:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Provision a Redis database on Upstash and add these values to your `.env` files. The limiter prefers Clerk `userId` as the key and falls back to IP if unauthenticated.

Local development without Redis:

```
DISABLE_RATE_LIMIT=true
```

When this flag is set (or when in development with no Upstash env configured), the middleware becomes a no-op.

```bash
supabase init
supabase start
supabase db reset
```


