# Render Deployment Guide (Manual + Optional Blueprint)

This project is a monorepo with:

- frontend static app (`apps/web`)
- backend Node + Socket.IO service (`apps/server`)
- Redis for room state
- Postgres for persistence

GitHub alone cannot host the backend + Redis + Postgres runtime. Use a full-stack host like Render.

## Option A: Fast Manual Setup (Recommended First Deploy)

### 1) Create Postgres

- Render Dashboard -> `New` -> `PostgreSQL`
- Use your preferred service name (for example `slaphard-postgres`)
- Pick one region and keep all services in that same region
- Save the **Internal Database URL**

### 2) Create Key Value (Redis)

- Render Dashboard -> `New` -> `Key Value`
- Service name (for example `slaphard-redis`)
- Same region as Postgres
- Save the **Internal Redis URL**

### 3) Create Backend Web Service

- Render Dashboard -> `New` -> `Web Service`
- Connect this repo, branch `main`
- Runtime: Node
- Root directory: leave empty (repo root)
- Build command:

```bash
pnpm install --frozen-lockfile --prod=false && pnpm --filter @slaphard/server build
```

- Start command:

```bash
pnpm --filter @slaphard/server db:migrate && pnpm --filter @slaphard/server start
```

- Health check path: `/health`
- Environment variables:
  - `NODE_ENV=production`
  - `ENABLE_DB_PERSISTENCE=true`
  - `ALLOW_IN_MEMORY_ROOM_STORE=false`
  - `DATABASE_URL=<internal postgres url>`
  - `REDIS_URL=<internal redis url>`
  - `CORS_ORIGINS=https://<your-frontend-service>.onrender.com` (set temporary value now, update after frontend deploy)

Deploy and verify:

- `https://<api-service>.onrender.com/health` returns JSON with `ok: true`.

### 4) Create Frontend Static Site

- Render Dashboard -> `New` -> `Static Site`
- Connect same repo, branch `main`
- Root directory: leave empty
- Build command:

```bash
pnpm install --frozen-lockfile --prod=false && pnpm --filter @slaphard/web build
```

- Publish directory: `apps/web/dist`
- Environment variable:
  - `VITE_SERVER_URL=https://<api-service>.onrender.com`

Deploy and note the frontend URL.

### 5) Final CORS Update

Update backend env var:

- `CORS_ORIGINS=https://<actual-frontend-url>`

Redeploy backend.

### 6) Smoke Test

- Open frontend in two browsers/devices
- Create room / join / start / flip / slap / action cards
- Stop game and create a new room
- Refresh one client and verify reconnect flow

## Option B: Render Blueprint (`render.yaml`)

This repo includes a starter blueprint at [`render.yaml`](../render.yaml).

Use this if you want infra-as-code setup. You still must provide:

- `CORS_ORIGINS`
- `VITE_SERVER_URL`

after the first service URLs are known.

## Expected Free-Tier Constraints

- Web service can sleep after inactivity.
- Postgres/Redis free tiers have hard limits.
- Key Value free mode is not durable for production data.

Use paid plans if you need always-on behavior.

## Troubleshooting

### Web cannot connect to socket

- Verify frontend `VITE_SERVER_URL` points to deployed API URL.
- Verify backend `CORS_ORIGINS` exactly matches frontend origin (`https://host` only, no trailing slash).

### Backend boot fails with env error

- Check required env vars in backend service.
- `ENABLE_DB_PERSISTENCE=true` requires valid `DATABASE_URL`.
- `ALLOW_IN_MEMORY_ROOM_STORE=false` requires valid `REDIS_URL`.

### Migration fails

- Re-check `DATABASE_URL` and DB availability.
- Retry deploy after fixing connection/auth settings.
