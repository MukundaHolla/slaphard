# SlapHard Phase 1

Web multiplayer reflex card game scaffolded as a pnpm monorepo.

## Workspace Layout

- `apps/web` React + TypeScript + Vite client
- `apps/server` Fastify + Socket.IO server
- `packages/shared` shared constants, domain types, Zod schemas, error codes
- `packages/engine` pure deterministic game engine + unit tests

## Quick Start

1. Run local Redis and Postgres.

2. Copy `.env.example` to `.env` and adjust credentials.

3. Install dependencies:

```bash
pnpm install
```

4. Run DB migrations:

```bash
pnpm --filter @slaphard/server db:migrate
```

5. Run web + server:

```bash
pnpm dev
```

6. Run tests:

```bash
pnpm test
```

## Server Environment

- `PORT` (default `3001`)
- `REDIS_URL` (required by default; set `ALLOW_IN_MEMORY_ROOM_STORE=true` only for fallback mode)
- `DATABASE_URL` (required when `ENABLE_DB_PERSISTENCE=true`)
- `ENABLE_DB_PERSISTENCE` (default `true`)
- `ALLOW_IN_MEMORY_ROOM_STORE` (default `false`)
- `CORS_ORIGINS` (comma-separated origins; required in production, defaults to local dev origins otherwise)

## Notes

- Game logic is server-authoritative and implemented in `packages/engine`.
- Socket payloads are validated with shared Zod contracts on both client and server.
- Client gets full hand only for the current player (`meHand`); other players receive counts only.
- Redis stores live room state and timers.
- Postgres stores room/match persistence snapshots on key transitions.

## Deployment

- Render deployment guide: [`docs/deploy-render.md`](docs/deploy-render.md)
- Optional Render Blueprint: [`render.yaml`](render.yaml)
