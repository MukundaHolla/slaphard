# SlapHard Phase 1

Web multiplayer reflex card game scaffolded as a pnpm monorepo.

## Workspace Layout

- `apps/web` React + TypeScript + Vite client
- `apps/server` Fastify + Socket.IO server
- `packages/shared` shared constants, domain types, Zod schemas, error codes
- `packages/engine` pure deterministic game engine + unit tests

## Quick Start

1. Install dependencies:

```bash
pnpm install
```

2. Run web + server:

```bash
pnpm dev
```

3. Run engine tests:

```bash
pnpm test
```

## Server Environment

- `PORT` (default `3001`)
- `REDIS_URL` (optional in Phase 1; if absent, in-memory room store is used)

## Notes

- Game logic is server-authoritative and implemented in `packages/engine`.
- Socket payloads are validated with shared Zod contracts on both client and server.
- Client gets full hand only for the current player (`meHand`); other players receive counts only.
- Postgres is scaffolded for future stats/accounts in `apps/server/src/db/postgres.ts`.
