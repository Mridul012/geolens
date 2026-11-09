# Vryse Lite

The analytics and optimization layer for AI search — what Ahrefs and Semrush did for Google
rankings, applied to AI-generated answers (ChatGPT, Perplexity, and similar engines).

It answers three questions a business currently has no instrumentation for:

1. **Do AI engines mention or cite us** when buyers ask relevant questions?
2. **Can AI systems access and understand our content?**
3. **What should we change to improve?**

Every score is transparent, versioned, and evidence-linked — never a black box.

## Stack (locked)

Node.js + TypeScript · Fastify · Prisma · BullMQ · Redis · PostgreSQL + pgvector ·
Cloudflare R2 · Better Auth · Crawlee + Playwright

No new ORMs, frameworks, queues, or state managers without explicit approval
(`docs/Engineering-Rules.md` §15.2).

## Architecture

```
        http/  ·  workers/          ← thin edges (controllers)
              │
              ▼
        application/                ← use cases; owns transactions, authz,
              │                       enqueueing, event emission
              ▼
          domain/                   ← pure, sync, deterministic; imports nothing

   infrastructure/  → implements application/ports/*; touches the world
   composition/     → the ONLY place that wires concrete → abstract
```

The dependency direction is **lint-enforced**, not aspirational: `npm run lint` fails on a
Prisma import inside `application/`, a provider SDK outside `infrastructure/ai/adapters/`,
or any external package inside `domain/`. `tests/unit/architecture/boundaries.test.ts`
asserts the rules themselves, so weakening the config breaks the build.

## Getting started

Requires Node 20.11+ and Docker.

```bash
cp .env.example .env
docker compose -f docker/docker-compose.local.yml up -d
npm ci
npm run dev
```

Three processes run from one image:

| Process | Local command | Health |
|---|---|---|
| api | `npm run dev` | `http://localhost:3000/health` |
| worker-browser | `npm run dev:worker:browser` | `http://localhost:3001/health` |
| worker-ai | `npm run dev:worker:ai` | `http://localhost:3002/health` |

## Commands

| Task | Command |
|---|---|
| Dev server | `npm run dev` |
| Tests | `npm test` |
| Lint (incl. boundaries) | `npm run lint` |
| Typecheck | `npm run typecheck` |
| Build | `npm run build` |
| Migrate | `npx prisma migrate dev` |

## Documentation

The seven planning documents in `docs/` are the source of truth; `CLAUDE.md` is the
working brief derived from them. Read `docs/Milestones.md` before writing code, and
`docs/Engineering-Rules.md` before arguing with any of it.
