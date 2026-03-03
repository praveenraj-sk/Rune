# Architecture Guide

Deep dive into how Rune works internally.

---

## Overview

Rune is a **ReBAC (Relationship-Based Access Control)** engine.
Instead of roles (`user:arjun is admin`), it stores relationships between entities:

```
user:arjun  -member->  group:managers  -owner->  zone:chennai  -viewer->  shipment:TN001
```

To answer "can `user:arjun` read `shipment:TN001`?" — Rune runs **BFS** over this graph.

---

## Request Lifecycle

```
Client                    Engine
  │                         │
  ├─ POST /v1/can ─────────►│
  │                         ├─ 1. authMiddleware (SHA-256 key hash lookup)
  │                         ├─ 2. JSON Schema validation (subject, action, object)
  │                         ├─ 3. can() function
  │                         │      ├─ Input validation (fail closed)
  │                         │      ├─ Build cache key
  │                         │      ├─ SCT staleness check
  │                         │      ├─ LRU cache lookup
  │                         │      ├─ BFS traversal (if cache miss)
  │                         │      ├─ Build trace + reason + suggested_fix
  │                         │      ├─ Get current LVN
  │                         │      ├─ Cache result
  │                         │      └─ Fire-and-forget: log decision to DB
  │                         ├─ 4. Return CanResult
  │◄────────────────────────┤
```

---

## Data Model

### Tuples (the relationship store)

```sql
CREATE TABLE tuples (
  tenant_id   UUID,      -- multi-tenancy isolation
  subject     TEXT,      -- e.g. "user:arjun" or "group:managers"
  relation    TEXT,      -- "owner" | "editor" | "viewer" | "member"
  object      TEXT,      -- e.g. "shipment:TN001"
  lvn         BIGINT,    -- Logical Version Number (for cache freshness)
  PRIMARY KEY (tenant_id, subject, relation, object)
);
```

### API Keys

```sql
CREATE TABLE api_keys (
  id          UUID,
  tenant_id   UUID,
  key_hash    TEXT UNIQUE,  -- SHA-256(raw_key), never store the raw key
  name        TEXT,
  last_used   TIMESTAMPTZ
);
```

### Decision Logs

```sql
CREATE TABLE decision_logs (
  id            UUID,
  tenant_id     UUID,
  subject, action, object, decision, status, reason, trace, suggested_fix,
  lvn, latency_ms, cache_hit
  -- Append-only, never update or delete
);
```

---

## BFS Traversal Algorithm

File: `packages/engine/src/bfs/traverse.ts`

**Key design:** one DB query per BFS depth level (not per node).

```
depth=0: frontier = ["user:arjun"]
  → DB: SELECT * FROM tuples WHERE subject = ANY(["user:arjun"])
  → edges: user:arjun -member-> group:managers
  → nextFrontier = ["group:managers"]

depth=1: frontier = ["group:managers"]
  → DB: SELECT * FROM tuples WHERE subject = ANY(["group:managers"])
  → edges: group:managers -owner-> zone:chennai
  → nextFrontier = ["zone:chennai"]

depth=2: frontier = ["zone:chennai"]
  → DB: SELECT * FROM tuples WHERE subject = ANY(["zone:chennai"])
  → edges: zone:chennai -viewer-> shipment:TN001
  → edge.object == target AND relation in validRelations("read") → FOUND!
```

**Safety limits:**
- `BFS_MAX_DEPTH` (default: 20) — stops runaway deep chains
- `BFS_MAX_NODES` (default: 1000) — stops runaway wide graphs
- `visited Set` — prevents infinite loops from circular relationships
- Object existence check fires before BFS — distinguishes NOT_FOUND from DENY

**Action → Relation mapping:**

| Action | Valid relations |
|---|---|
| `read` | `owner`, `editor`, `viewer`, `member` |
| `edit` | `owner`, `editor` |
| `delete` | `owner` |
| `manage` | `owner` |

---

## Caching (LRU + SCT)

File: `packages/engine/src/cache/lru.ts`

**Cache key:** `{tenant_id}:{subject}:{object}:{action}`

**Cache invalidation:** The entire tenant's cache is wiped on every `POST /v1/tuples` or `DELETE /v1/tuples`. Brute-force O(n) but safe and simple at Phase 1 scale.

**SCT (Staleness Check Token):** Each cached entry stores an `lvn`. Clients can pass their last-known `lvn` in the `sct` field to force cache bypass if the cache entry is older than their write.

```
Client writes → gets lvn=42
Client checks with sct:{lvn:42}
Engine: cache entry has lvn=38 → stale → bypass cache → run BFS
```

---

## Multi-Tenancy

Every DB query includes `tenant_id` — there is no way to access another tenant's data:

```sql
SELECT ... FROM tuples WHERE tenant_id = $1 AND ...
```

The `tenant_id` is derived from the API key lookup — the client cannot set it. Even if a client sends another tenant's subject/object in the body, the query is scoped to their tenant.

---

## Security Design

| Property | Implementation |
|---|---|
| Fail-closed | `can()` wrapped in try/catch — any error → DENY |
| No raw key storage | Keys hashed SHA-256 before DB insert |
| No stack traces in responses | Error handler strips them |
| Tenant isolation | Every query scoped by tenant_id from auth middleware |
| BFS limits | Depth (20) + node (1000) limits prevent DoS |
| Circular graph safe | `visited` Set prevents infinite loops |
| Schema validation | Fastify validates body shape before auth middleware |

---

## ESM Import Hoisting Problem (and fix)

Node.js ESM hoists all `import` statements to the top of the file before any code runs.
This means `config/index.ts` was evaluated before `dotenv` loaded `.env`.

**Fix:** `env-setup.ts` is a separate file that calls `loadEnv()`.
It's imported as a **side-effect** at the very top of `server.ts`:

```ts
// server.ts
import './env-setup.js'    // ← this runs FIRST (ESM resolves deps in order)
import { config } from './config/index.js'  // ← config reads env AFTER dotenv loaded
```

The same pattern is used in `tests/setup.ts` — `config()` is called first,
then `db/client.ts` is loaded via dynamic `await import()` so it runs after dotenv.

---

## Logical Version Number (LVN)

Every write to `tuples` fetches a new LVN from `lvn_seq` (a Postgres sequence).
LVN is monotone-increasing — clients use it for SCT staleness checks.

```sql
CREATE SEQUENCE lvn_seq START 1 INCREMENT 1;
SELECT nextval('lvn_seq')   -- called on every POST/DELETE /tuples
```

---

## Explainability

File: `packages/engine/src/engine/explain.ts`

Three outputs built for every decision:

- **trace:** ordered list of nodes visited — `start → connected → connected → not_connected`
- **reason:** one plain-English sentence explaining the decision
- **suggested_fix:** 1-5 suggestions for how to grant access (DENY only), built from a reverse lookup of who already has access to the target object
