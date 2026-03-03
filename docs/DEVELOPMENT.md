# Development Guide

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org) |
| pnpm | 9.x | `npm install -g pnpm@9` |
| Docker Desktop | latest | [docker.com](https://www.docker.com/products/docker-desktop/) |

---

## First-time Setup

```bash
git clone https://github.com/praveenraj-sk/Rune.git
cd Rune

# 1. Install all workspace dependencies
pnpm install

# 2. Start Postgres (runs on port 5433)
docker compose up -d

# 3. Copy and configure environment
cp .env.example .env

# 4. Run setup (creates DB schema + your first API key)
pnpm run setup

# 5. Start the engine in dev mode (hot reload)
pnpm dev
```

Engine is now running at **http://localhost:4078**

Check it's healthy:
```bash
curl http://localhost:4078/v1/health
# → {"status":"ok","db":"connected"}
```

---

## Environment Variables

All config lives in `.env` at the project root. Copy from `.env.example`:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4078` | Engine HTTP port |
| `NODE_ENV` | `development` | `development` or `production` |
| `DATABASE_URL` | `postgresql://rune:runepassword@localhost:5433/runedb` | Postgres connection string |
| `API_KEY_SALT` | (generate with openssl) | Salt for key hashing |
| `CACHE_MAX_SIZE` | `10000` | Max LRU cache entries |
| `BFS_MAX_DEPTH` | `20` | Max BFS traversal depth |
| `BFS_MAX_NODES` | `1000` | Max BFS nodes visited |

> **Never commit `.env`** — it is in `.gitignore`. Share secrets via your team's secret manager.

---

## Daily Development Workflow

```bash
# Start everything
docker compose up -d   # make sure Postgres is running
pnpm dev               # start engine with hot reload

# Engine restarts automatically on file changes (tsx watch)
# Edit any file in packages/engine/src/ and it reloads in ~500ms
```

---

## Project Structure

```
rune/
├── packages/
│   ├── engine/               # The authorization engine (Fastify server)
│   │   ├── src/
│   │   │   ├── server.ts     # Entry point
│   │   │   ├── env-setup.ts  # ESM-safe dotenv loader (must be first import)
│   │   │   ├── config/       # Zod schema + env validation
│   │   │   ├── db/           # Postgres pool + query helper
│   │   │   ├── cache/        # LRU in-memory cache
│   │   │   ├── bfs/          # BFS traversal algorithm
│   │   │   ├── engine/       # can() + explainability
│   │   │   ├── middleware/   # Auth + error handler
│   │   │   ├── routes/       # HTTP route handlers
│   │   │   └── logger/       # Pino structured logger
│   │   ├── tests/            # Vitest integration + unit tests
│   │   └── scripts/          # setup.mts (DB init + API key gen)
│   └── sdk/                  # @runeauth/sdk npm package
│       └── src/
│           ├── client.ts     # HTTP client (native fetch)
│           ├── fluent.ts     # can().do().on() builder
│           ├── types.ts      # Shared TypeScript types
│           └── index.ts      # Public API surface
├── docker-compose.yml        # Postgres container
├── .env.example              # Template for .env
└── docs/                     # This folder
```

---

## Making Code Changes

### Engine changes

```bash
# Edit src files — engine reloads automatically
# Example: add a new field to the can() response

# 1. Edit the source file
# 2. Check engine reloaded in terminal (no errors)
# 3. Test with curl or run tests
curl -X POST http://localhost:4078/v1/can \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"subject":"user:arjun","action":"read","object":"shipment:TN001"}'
```

### SDK changes

```bash
cd packages/sdk
# Edit src files
pnpm build          # compile TypeScript
pnpm test           # run SDK tests
```

### Config changes

If you change the Zod schema in `config/index.ts`, update `.env.example` too.

---

## Typecheck

```bash
# From project root — checks both engine + SDK
pnpm run typecheck
```

---

## Resetting the Database

```bash
# Full reset (deletes all data including API keys)
docker compose down -v        # removes the postgres volume
docker compose up -d          # fresh Postgres
pnpm run setup                # re-creates schema + new API key

# Update .env with the new API key
```

---

## Common Issues

| Problem | Fix |
|---|---|
| `Invalid Rune config` on startup | `DATABASE_URL` not set — copy `.env.example` to `.env` |
| `EADDRINUSE 4078` | Port in use — `lsof -ti:4078 \| xargs kill -9` |
| `role "rune" does not exist` | DB not started or wrong port — `docker compose up -d` |
| Tests fail with 401 | Dirty DB from bad run — `docker compose down -v && docker compose up -d && pnpm run setup` |
| `pnpm setup` installs pnpm itself | Use `pnpm run setup` (with `run`) |
