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

## Endpoints

- `GET /health` → `{ ok: true, env: "development|production" }`
- `GET /` → health text
- `GET /api/me` → requires `Authorization: Bearer <supabase_jwt>`; returns `{ user }`
 - `POST /api/analyze-nail` → requires `Authorization: Bearer <supabase_jwt>`
   - body: `{ image_base64: string }` or `{ storage_bucket: string, storage_path: string }`
   - returns: `{ analysis: { summary, issues[], recommendations[], confidence } }`

Supabase integration will be added later.
