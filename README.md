# Rune

**Relationship-based authorization engine.** Add fine-grained, graph-traversal permissions to your app in minutes.

> *"Does user:arjun have read access to shipment:TN001?"*
> Rune traces the relationship graph — user → group → zone → resource — and gives you a clear ALLOW or DENY with a full explanation.

---

## What it does

- **BFS graph traversal** — permissions flow through relationships (`user → group → zone → resource`)
- **Instant decisions** — median latency < 5ms with in-process LRU cache
- **Full explainability** — every decision includes a trace, reason, and suggested fix
- **Tenant-isolated** — every tenant's data is completely separated at the DB level
- **Fail-closed** — any error returns DENY, never ALLOW

---

## Quickstart

### 1. Prerequisites
- Node.js 18+
- Podman (or Docker)
- pnpm

### 2. Clone and install

```bash
git clone https://github.com/praveenraj-sk/Rune.git
cd Rune
pnpm install
```

### 3. Start Postgres

```bash
# Docker
docker-compose up -d

# Podman
podman-compose up -d
```

### 4. Configure environment

```bash
cp .env.example .env
# Edit .env — set DATABASE_URL if needed
```

### 5. Run setup (creates schema + your first API key)

```bash
pnpm --filter @rune/engine exec tsx scripts/setup.mts
```

Output:
```
  ✓ Setup complete!

  Tenant ID  11111111-...
  API Key    rune_abc123...

  Save your API key — it will not be shown again.
```

### 6. Start the engine

```bash
cd packages/engine
pnpm dev
# Engine running at http://localhost:3001
```

---

## SDK Usage

```bash
npm install @rune/sdk
```

```ts
import { Rune } from '@rune/sdk'

const rune = new Rune({
  apiKey:  'rune_abc123...',
  baseUrl: 'http://localhost:3001',
})

// Add a relationship
await rune.allow({ subject: 'user:alice', relation: 'viewer', object: 'doc:report' })

// Check access — fluent style
const result = await rune.can('user:alice').do('read').on('doc:report')
console.log(result.status)  // "ALLOW"
console.log(result.trace)   // [{ node: 'user:alice', result: 'start' }, ...]

// Check access — direct style  
const r2 = await rune.check({ subject: 'user:alice', action: 'read', object: 'doc:report' })

// Remove a relationship
await rune.revoke({ subject: 'user:alice', relation: 'viewer', object: 'doc:report' })

// Get recent decisions (for your dashboard)
const { logs } = await rune.logs()

// Health check
const health = await rune.health()
```

---

## API Reference

### `POST /v1/can`

Check whether a subject can perform an action on an object.

**Headers:** `x-api-key: <your-key>`

**Request:**
```json
{
  "subject": "user:arjun",
  "action":  "read",
  "object":  "shipment:TN001"
}
```

**Response:**
```json
{
  "decision":      "allow",
  "status":        "ALLOW",
  "reason":        "Access granted — valid relationship found between user:arjun and shipment:TN001",
  "trace": [
    { "node": "user:arjun",             "result": "start" },
    { "node": "group:chennai_managers", "result": "connected" },
    { "node": "zone:chennai",           "result": "connected" },
    { "node": "shipment:TN001",         "result": "connected" }
  ],
  "suggested_fix": [],
  "cache_hit":     false,
  "latency_ms":    4.2,
  "sct":           { "lvn": 42 }
}
```

**Actions:** `read` | `edit` | `delete` | `manage`

**Status values:**
| Status | Meaning |
|---|---|
| `ALLOW` | Access granted |
| `DENY` | No valid relationship path found |
| `NOT_FOUND` | The object doesn't exist in the tuple store |

---

### `POST /v1/tuples`

Add a relationship.

```json
{ "subject": "user:alice", "relation": "viewer", "object": "doc:report" }
```

**Relations:** `owner` | `editor` | `viewer` | `member`

---

### `DELETE /v1/tuples`

Remove a relationship. Same body as POST.

---

### `GET /v1/logs`

Returns last 100 authorization decisions for your tenant.

---

### `GET /v1/health`

No auth required. Returns `{ "status": "ok", "db": "connected" }`.

---

## How relationships work

Rune uses **Relationship-Based Access Control (ReBAC)**. You define *who has what relationship to what*, and Rune figures out access by traversal.

```
user:arjun  --[member]-->  group:chennai_managers
                                    |
                               [owner]
                                    ↓
                             zone:chennai
                                    |
                              [viewer]
                                    ↓
                          shipment:TN001  ✅ ALLOW
```

**Relation semantics:**

| Relation | Grants `read` | Grants `edit` | Grants `delete` | Grants `manage` |
|---|---|---|---|---|
| `owner`   | ✅ | ✅ | ✅ | ✅ |
| `editor`  | ✅ | ✅ | ✅ | ❌ |
| `viewer`  | ✅ | ❌ | ❌ | ❌ |
| `member`  | traversal only | traversal only | traversal only | traversal only |

`member` is a traversal relation — it doesn't grant access itself, but lets the BFS continue to parent groups/zones.

---

## Security

- **API keys** are hashed with SHA-256 before storage — raw keys never hit the DB
- **Tenant isolation** — every query is scoped to `tenant_id`, no cross-tenant leakage
- **Fail-closed** — service errors return DENY, not ALLOW
- **BFS limits** — max depth 10, max nodes 1000 — protects against graph bombs

---

## Project structure

```
rune/
├── packages/
│   ├── engine/          # Fastify API server (TypeScript)
│   │   └── src/
│   │       ├── bfs/     # BFS graph traversal
│   │       ├── cache/   # LRU cache with tenant isolation
│   │       ├── config/  # Env validation (Zod)
│   │       ├── db/      # Postgres pool + schema
│   │       ├── engine/  # can() decision function + explainability
│   │       ├── logger/  # Pino structured logging
│   │       ├── middleware/ # Auth + error handler
│   │       └── routes/  # POST /can, /tuples, GET /health, /logs
│   └── sdk/             # @rune/sdk (zero dependencies)
│       └── src/
│           ├── client.ts  # HTTP client
│           ├── fluent.ts  # can().do().on() builder
│           ├── types.ts   # Shared types
│           └── index.ts   # Public API
├── scripts/
│   └── setup.mts        # First-time setup wizard (tsx)
├── docker-compose.yml
└── .env.example
```

---

## Running tests

```bash
cd packages/engine
pnpm test
```

**Test coverage:** 69 tests across 7 suites
- Unit: LRU cache (7), BFS traversal (8), can() function (7), DB constraints (14), Failure modes (8)
- Integration: Routes (11), Security (10)
- SDK: 18 tests

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | Postgres connection string |
| `PORT` | ❌ | `3001` | Engine HTTP port |
| `NODE_ENV` | ❌ | `development` | `development` or `production` |
| `MAX_CACHE_SIZE` | ❌ | `10000` | Max LRU cache entries |
| `MAX_BFS_DEPTH` | ❌ | `20` | Max BFS traversal depth |
| `MAX_BFS_NODES` | ❌ | `1000` | Max BFS nodes visited |
| `API_KEY_SALT` | ❌ | — | Extra salt for key hashing |
