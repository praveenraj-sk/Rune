# Rune — Product Design Document

> **Version:** 2.2.1 (as deployed on Render)
> **Last Updated:** March 2026
> **Architecture:** Google Zanzibar-inspired Relationship-Based Access Control (ReBAC)

---

## What is Rune?

Rune is a **self-hosted authorization engine** that answers one question:

> *"Can **user:arjun** do **read** on **shipment:TN001**?"*

It stores relationships as tuples (`subject → relation → object`), traverses a graph using BFS, and returns `ALLOW` or `DENY` with full explainability.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                         CLIENTS                              │
│                                                              │
│  Node.js App ──► @runeauth/sdk (npm)                         │
│  Any HTTP client ──► REST API                                │
└──────────────────┬───────────────────────────────────────────┘
                   │ HTTP (or SDK local cache)
                   ▼
┌──────────────────────────────────────────────────────────────┐
│                     RUNE ENGINE (Fastify)                     │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐ │
│  │ can.route │  │ tuples   │  │ health   │  │ setup/migrate│ │
│  │ POST /can │  │ POST/DEL │  │ GET      │  │ POST         │ │
│  └────┬─────┘  └────┬─────┘  └──────────┘  └──────────────┘ │
│       │              │                                        │
│  ┌────▼──────────────▼────────────────────────────────────┐  │
│  │                 AUTH MIDDLEWARE                          │  │
│  │  x-api-key → SHA-256 hash → lookup api_keys table      │  │
│  │  Attaches tenant_id to request                          │  │
│  │  Fail-closed: any error → 401                           │  │
│  └────┬───────────────────────────────────────────────────┘  │
│       │                                                       │
│  ┌────▼──────────────────────────────────────────────────┐   │
│  │              AUTHORIZATION ENGINE (can.ts)              │   │
│  │                                                         │   │
│  │  1. Validate inputs → DENY on empty field               │   │
│  │  2. Build cache key                                     │   │
│  │  3. Check SCT freshness (bypass cache if stale)         │   │
│  │  4. Check LRU cache → return if hit                     │   │
│  │  5. BFS graph traversal                                 │   │
│  │  6. Handle NOT_FOUND (don't cache)                      │   │
│  │  7. Handle limit hits (don't cache)                     │   │
│  │  8. Build explainability (trace, reason, suggested_fix) │   │
│  │  9. Get current LVN                                     │   │
│  │  10. Cache result (ALLOW/DENY only)                     │   │
│  │  11. Log decision (fire-and-forget)                     │   │
│  │  12. Return result                                      │   │
│  │                                                         │   │
│  │  FAIL-CLOSED: entire function in try/catch → DENY       │   │
│  └────┬───────────────────────────────────────────────────┘   │
│       │                                                       │
│  ┌────▼────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │ BFS Traversal   │  │ LRU Cache    │  │ Decision Logger  │ │
│  │ traverse.ts     │  │ lru.ts       │  │ (fire & forget)  │ │
│  │                 │  │              │  │                  │ │
│  │ Batched queries │  │ 10K entries  │  │ Async insert to  │ │
│  │ per depth level │  │ SCT-aware    │  │ decision_logs    │ │
│  │ MAX_DEPTH=20    │  │ Tenant-wipe  │  │                  │ │
│  │ MAX_NODES=1000  │  │ on writes    │  │                  │ │
│  └────┬────────────┘  └──────────────┘  └──────────────────┘ │
│       │                                                       │
│  ┌────▼──────────────────────────────────────────────────┐   │
│  │                     POSTGRESQL                          │   │
│  │  tuples │ api_keys │ decision_logs │ schemas │ lvn_seq  │   │
│  └─────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

---

## Package Structure

```
rune/
├── packages/
│   ├── engine/                    # Authorization engine (Fastify server)
│   │   ├── src/
│   │   │   ├── server.ts          # Entry point — registers routes
│   │   │   ├── env-setup.ts       # dotenv loader (dev only, skipped in prod)
│   │   │   ├── config/index.ts    # Zod-validated config from env vars
│   │   │   ├── db/
│   │   │   │   ├── client.ts      # Postgres connection pool + query helper
│   │   │   │   └── schema.sql     # DB schema (tuples, api_keys, decision_logs)
│   │   │   ├── bfs/
│   │   │   │   ├── traverse.ts    # BFS graph traversal (batched per depth)
│   │   │   │   └── types.ts       # getValidRelations() + TraversalResult
│   │   │   ├── engine/
│   │   │   │   ├── can.ts         # Core authorization pipeline (12 steps)
│   │   │   │   ├── explain.ts     # trace, reason, suggested_fix builders
│   │   │   │   └── types.ts       # CanInput, CanResult, TraceNode
│   │   │   ├── cache/
│   │   │   │   └── lru.ts         # LRU cache with SCT/LVN staleness
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts        # API key auth (SHA-256 hash lookup)
│   │   │   │   └── error-handler.ts
│   │   │   ├── logger/
│   │   │   │   └── index.ts       # Pino structured logger
│   │   │   └── routes/
│   │   │       ├── can.route.ts   # POST /v1/can — authorization check
│   │   │       ├── tuples.route.ts# POST/DELETE /v1/tuples — manage relations
│   │   │       ├── health.route.ts# GET /v1/health — health + DB status
│   │   │       └── setup.route.ts # POST /v1/setup, /v1/migrate
│   │   ├── tests/
│   │   │   └── integration.test.mjs  # 33 live tests against Render
│   │   ├── scripts/
│   │   │   └── setup.mts          # Local setup script (DB + tenant + key)
│   │   └── Dockerfile             # Production Docker image
│   │
│   └── sdk/                       # Node.js SDK (@runeauth/sdk on npm)
│       ├── src/
│       │   ├── index.ts           # Rune class — public API entry point
│       │   ├── client.ts          # HTTP client + retry + circuit breaker
│       │   ├── cache.ts           # Local LRU cache (opt-in, TTL-based)
│       │   ├── fluent.ts          # can('user').do('read').on('doc') builder
│       │   └── types.ts           # All exported types
│       ├── tests/
│       │   └── sdk.test.ts        # 18 unit tests (vitest)
│       └── tsup.config.ts         # Dual CJS/ESM build config
│
├── docs/
│   ├── DEPLOY.md                  # Render deployment guide
│   ├── CREDENTIALS.md             # Production credentials (gitignored)
│   └── DESIGN.md                  # ← this file
│
└── Dockerfile                     # Root Dockerfile for Render
```

---

## Database Schema

```sql
-- Relationships (the core data)
CREATE TABLE tuples (
  tenant_id   UUID        NOT NULL,
  subject     TEXT        NOT NULL,     -- "user:arjun", "group:engineering"
  relation    TEXT        NOT NULL,     -- any string: "viewer", "approve", etc.
  object      TEXT        NOT NULL,     -- "doc:123", "shipment:TN001"
  lvn         BIGINT      NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, subject, relation, object)
);

-- API keys (hashed, never stored in plain text)
CREATE TABLE api_keys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL,
  key_hash    TEXT        NOT NULL UNIQUE,  -- SHA-256 of raw key
  name        TEXT        NOT NULL,
  last_used   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Decision audit log
CREATE TABLE decision_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  subject       TEXT NOT NULL,
  action        TEXT NOT NULL,
  object        TEXT NOT NULL,
  decision      TEXT NOT NULL,        -- 'allow' or 'deny'
  status        TEXT NOT NULL,        -- 'ALLOW', 'DENY', 'NOT_FOUND'
  reason        TEXT,
  trace         JSONB,
  suggested_fix JSONB,
  lvn           BIGINT,
  latency_ms    DOUBLE PRECISION,
  cache_hit     BOOLEAN,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Monotone version number for cache invalidation
CREATE SEQUENCE lvn_seq START 1;
```

---

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/v1/can` | API key | Check permission — returns ALLOW/DENY with explainability |
| `POST` | `/v1/tuples` | API key | Add a relationship (upsert, idempotent) |
| `DELETE` | `/v1/tuples` | API key | Remove a relationship |
| `GET` | `/v1/logs` | API key | Get recent decision audit logs |
| `GET` | `/v1/health` | None | Health check + DB status |
| `POST` | `/v1/setup` | SETUP_SECRET | One-time setup (create schema + tenant + API key) |
| `POST` | `/v1/migrate` | SETUP_SECRET | Run DB migrations |

---

## BFS Algorithm — How Permission Checks Work

```
Input: can user:arjun do read on shipment:TN001?

Step 1: What relations grant "read"?
        → getValidRelations('read') = ['viewer', 'editor', 'owner']
        → Custom actions: getValidRelations('approve') = ['approve', 'owner']

Step 2: Does shipment:TN001 exist in tuples?
        → No → return NOT_FOUND
        → Yes → continue to BFS

Step 3: BFS from user:arjun (breadth-first)
        Depth 0: frontier = [user:arjun]
          → Query: all tuples WHERE subject IN ('user:arjun')
          → Found: user:arjun → viewer → shipment:TN001  ✅ MATCH!
          → relation 'viewer' is in ['viewer','editor','owner']
          → ALLOW

        If no direct match, expand to groups:
          → user:arjun → member → group:logistics
          → group:logistics → viewer → shipment:TN001  ✅ MATCH at depth 1

Performance: One DB query per BFS depth level, not per node.
Safety: MAX_DEPTH=20, MAX_NODES=1000, visited Set prevents loops.
```

---

## SDK Features (v2.2.1)

### Fluent API
```typescript
const rune = new Rune({
  apiKey: 'rune_...',
  baseUrl: 'https://rune-engine.onrender.com',
})

// Fluent check
const result = await rune.can('user:arjun').do('read').on('shipment:TN001')
// result.status → 'ALLOW' or 'DENY'

// Manage relationships
await rune.allow({ subject: 'user:arjun', relation: 'viewer', object: 'doc:1' })
await rune.revoke({ subject: 'user:arjun', relation: 'viewer', object: 'doc:1' })

// Audit logs
const { logs } = await rune.logs()
```

### Retry + Circuit Breaker (built-in, configurable)
```typescript
const rune = new Rune({
  apiKey: 'rune_...',
  baseUrl: 'https://rune-engine.onrender.com',
  retry: { attempts: 2, baseDelay: 200, maxDelay: 2000 },
  circuitBreaker: { threshold: 5, resetTimeout: 30000 },
})
```

- **Retry:** Exponential backoff with ±25% jitter. Only retries 5xx and network errors.
- **Circuit breaker:** Opens after 5 consecutive failures. Half-opens after 30s to test.
- Both can be disabled: `retry: false`, `circuitBreaker: false`

### Local Decision Cache (opt-in)
```typescript
const rune = new Rune({
  apiKey: 'rune_...',
  baseUrl: 'https://rune-engine.onrender.com',
  cache: { maxSize: 1000, ttl: 30000 },
})
```

- LRU eviction, TTL-based expiry, SCT/LVN-aware invalidation
- `check()` reads cache before HTTP, stores results after
- `allow()`/`revoke()` clear the cache on writes
- Cached responses include `(sdk-cache)` in reason string

### Dual CJS/ESM Build
```javascript
// ESM
import { Rune } from '@runeauth/sdk'

// CommonJS
const { Rune } = require('@runeauth/sdk')
```

---

## Security Model

| Mechanism | Implementation |
|---|---|
| **API key hashing** | SHA-256, raw key never stored or logged |
| **Tenant isolation** | Every query filtered by `tenant_id` |
| **Fail-closed** | Any error in `can()` → DENY (never ALLOW on error) |
| **Auth middleware** | Missing/invalid key → 401 (never leaks internals) |
| **Error handler** | Global handler hides stack traces in production |
| **BFS safety** | MAX_DEPTH=20, MAX_NODES=1000 prevent abuse |
| **Setup protection** | `SETUP_SECRET` env var required for `/v1/setup` |
| **Credentials** | `CREDENTIALS.md` is gitignored |

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | Postgres connection string |
| `PORT` | — | `4078` | Server port |
| `NODE_ENV` | — | `development` | `development` / `production` |
| `API_KEY_SALT` | ✅ prod | dev default | Salt for API key hashing |
| `SETUP_SECRET` | ✅ prod | — | Protects `/v1/setup` endpoint |
| `MAX_CACHE_SIZE` | — | `10000` | LRU cache max entries |
| `MAX_BFS_DEPTH` | — | `20` | Max BFS traversal depth |
| `MAX_BFS_NODES` | — | `1000` | Max BFS nodes to visit |

---

## Deployment

- **Platform:** Render (free tier)
- **URL:** `https://rune-engine.onrender.com`
- **Database:** Render managed Postgres
- **Docker:** Multi-stage build, pnpm workspace, Node 18
- **Auto-deploy:** Push to `main` → Render rebuilds and deploys

---

## Test Coverage

| Suite | Tests | What it covers |
|---|---|---|
| SDK unit tests | 18 | Constructor, fluent API, check, allow/revoke, logs, health, errors, timeouts |
| Integration tests | 33 | Health, migration, standard relations, custom actions/relations, NOT_FOUND, revoke, logs, auth errors, explainability |
| **Total** | **51** | |

---

## Version History

| Version | Date | Changes |
|---|---|---|
| 1.0.0 | March 2026 | Initial release — ReBAC engine + SDK |
| 2.0.0 | March 2026 | SDK renamed types (Permission, Grant, Audit) |
| 2.1.0 | March 2026 | Custom actions + custom relations (any string) |
| 2.2.0 | March 2026 | Retry + circuit breaker + CJS/ESM dual build |
| 2.2.1 | March 2026 | SDK local decision cache (opt-in) |
