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
- `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (required for auth middleware)
  - Note: `SUPABASE_SERVICE_ROLE_KEY` is also supported for backwards compatibility
  - Use the **Secret Key** (not the Publishable Key) from your Supabase dashboard
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

## Database Migrations

To run migrations on your cloud Supabase instance:

1. **Login to Supabase CLI** (if not already logged in):
   ```bash
   supabase login
   ```

2. **Link your project** to your cloud Supabase instance:
   ```bash
   npm run db:link
   # Or: supabase link --project-ref your-project-ref
   ```
   You'll need your project reference ID (found in your Supabase dashboard URL or settings).

3. **Push migrations** to the cloud database:
   ```bash
   npm run db:push
   # Or: supabase db push
   ```

4. **Check migration status**:
   ```bash
   npm run db:status
   # Or: supabase migration list
   ```

5. **Pull remote migrations** (if remote has migrations not in local):
   ```bash
   npm run db:pull
   # Or: supabase db pull
   ```
   This will download any migrations that exist on the remote but not locally.

6. **Repair migration history** (if you need to fix migration status):
   ```bash
   npm run db:repair -- --status reverted <migration-timestamp>
   # Or: supabase migration repair --status reverted <migration-timestamp>
   ```

**Note:** Make sure you have the correct project linked before pushing migrations. The migrations will be applied in chronological order based on their filenames.

**Troubleshooting:** If you get an error about "Remote migration versions not found in local migrations directory":
- Option 1: Pull the missing migration: `npm run db:pull`
- Option 2: If the migration isn't needed, repair it: `npm run db:repair -- --status reverted <migration-timestamp>`

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


