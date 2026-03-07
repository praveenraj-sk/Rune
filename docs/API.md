# Rune Engine — API Reference

> Base URL: `http://localhost:4078/v1`

All endpoints require an `x-api-key` header unless noted otherwise.
Rate limits apply per API key (100 req/10s) and per IP (200 req/10s).
Admin endpoints have a stricter limit (20 req/10s).

Every response includes an `x-request-id` header for log correlation.

---

## Authentication

Include your API key in every request:

```
x-api-key: rune_sk_your_key_here
```

Unauthenticated requests receive:

```json
{ "error": "unauthorized" }
```

**Status Code:** `401 Unauthorized`

---

## Error Codes

| HTTP Status | Error | When |
|-------------|-------|------|
| `400` | `bad_request` | Missing/invalid fields in request body |
| `401` | `unauthorized` | Missing or invalid `x-api-key` |
| `429` | `rate_limit_exceeded` | Too many requests (per key, IP, or admin) |
| `500` | `internal_error` | Server error — check logs |
| `503` | `service_unavailable` | Database is down |

---

## Authorization

### `POST /v1/can` — Check permission

Check whether a subject can perform an action on an object.

**Request:**

```bash
curl -X POST http://localhost:4078/v1/can \
  -H "Content-Type: application/json" \
  -H "x-api-key: rune_sk_your_key" \
  -d '{
    "subject": "user:arjun",
    "action": "read",
    "object": "shipment:TN001"
  }'
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `subject` | string | ✅ | The actor (e.g. `user:arjun`, `group:managers`) |
| `action` | string | ✅ | The action to check (e.g. `read`, `edit`, `delete`) |
| `object` | string | ✅ | The target resource (e.g. `shipment:TN001`, `doc:report`) |
| `context` | object | ❌ | Optional context (e.g. `{ "time": "2024-01-01" }`) |
| `sct` | object | ❌ | Staleness Control Token: `{ "lvn": 42 }` |

**Response (ALLOW):**

```json
{
  "decision": "allow",
  "status": "ALLOW",
  "reason": "Access granted — valid relationship found between user:arjun and shipment:TN001",
  "trace": [
    { "node": "user:arjun", "result": "start" },
    { "node": "group:chennai_managers", "result": "connected" },
    { "node": "zone:chennai", "result": "connected" },
    { "node": "shipment:TN001", "result": "connected" }
  ],
  "suggested_fix": [],
  "cache_hit": false,
  "latency_ms": 4.2,
  "sct": { "lvn": 42 }
}
```

**Response (DENY):**

```json
{
  "decision": "deny",
  "status": "DENY",
  "reason": "No valid relationship path found between user:bob and shipment:TN001",
  "trace": [
    { "node": "user:bob", "result": "start" },
    { "node": "user:bob", "result": "dead_end" }
  ],
  "suggested_fix": [
    { "subject": "user:bob", "relation": "viewer", "object": "shipment:TN001" }
  ],
  "cache_hit": false,
  "latency_ms": 2.1,
  "sct": { "lvn": 42 }
}
```

**Response (NOT_FOUND):**

```json
{
  "decision": "deny",
  "status": "NOT_FOUND",
  "reason": "Object does not exist in the relationship store",
  "trace": [],
  "suggested_fix": [],
  "cache_hit": false,
  "latency_ms": 0.8,
  "sct": { "lvn": 42 }
}
```

**Status values:**

| Status | Meaning |
|--------|---------|
| `ALLOW` | BFS found a valid relationship path |
| `DENY` | No path found — includes `suggested_fix` |
| `NOT_FOUND` | Object doesn't exist in tuple store (not cached) |

---

### `POST /v1/can/batch` — Batch permission check

Check up to 25 permissions in a single request. Runs all checks in parallel.

**Request:**

```bash
curl -X POST http://localhost:4078/v1/can/batch \
  -H "Content-Type: application/json" \
  -H "x-api-key: rune_sk_your_key" \
  -d '{
    "checks": [
      { "subject": "user:arjun", "action": "read", "object": "shipment:TN001" },
      { "subject": "user:arjun", "action": "delete", "object": "shipment:TN001" },
      { "subject": "user:bob", "action": "read", "object": "doc:report" }
    ]
  }'
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `checks` | array | ✅ | 1–25 permission checks |
| `checks[].subject` | string | ✅ | The actor |
| `checks[].action` | string | ✅ | The action |
| `checks[].object` | string | ✅ | The target resource |
| `checks[].sct` | object | ❌ | Per-check staleness token |

**Response:**

```json
{
  "results": [
    { "subject": "user:arjun", "action": "read", "object": "shipment:TN001", "decision": "allow", "status": "ALLOW", "cache_hit": false, "latency_ms": 3.1 },
    { "subject": "user:arjun", "action": "delete", "object": "shipment:TN001", "decision": "deny", "status": "DENY", "cache_hit": false, "latency_ms": 2.4 },
    { "subject": "user:bob", "action": "read", "object": "doc:report", "decision": "deny", "status": "NOT_FOUND", "cache_hit": false, "latency_ms": 0.6 }
  ],
  "total_latency_ms": 4.8
}
```

---

## Relationship Management

### `POST /v1/tuples` — Add a relationship

```bash
curl -X POST http://localhost:4078/v1/tuples \
  -H "Content-Type: application/json" \
  -H "x-api-key: rune_sk_your_key" \
  -d '{
    "subject": "user:alice",
    "relation": "viewer",
    "object": "doc:report"
  }'
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `subject` | string | ✅ | The actor being granted access |
| `relation` | string | ✅ | The role/relation (e.g. `owner`, `editor`, `viewer`, `member`) |
| `object` | string | ✅ | The target resource |

**Response:**

```json
{ "success": true, "lvn": 43 }
```

The `lvn` (Logical Version Number) increments on every write. Use it for staleness control.

### `DELETE /v1/tuples` — Remove a relationship

Same body as POST. Removes the exact `(subject, relation, object)` tuple.

```bash
curl -X DELETE http://localhost:4078/v1/tuples \
  -H "Content-Type: application/json" \
  -H "x-api-key: rune_sk_your_key" \
  -d '{
    "subject": "user:alice",
    "relation": "viewer",
    "object": "doc:report"
  }'
```

**Response:**

```json
{ "success": true, "lvn": 44 }
```

### `GET /v1/tuples` — List relationships

Paginated list of all tuples for your tenant.

```bash
curl "http://localhost:4078/v1/tuples?page=1&limit=50&search=alice" \
  -H "x-api-key: rune_sk_your_key"
```

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | number | `1` | Page number |
| `limit` | number | `50` | Items per page (max 100) |
| `search` | string | — | Filter by subject, relation, or object (case-insensitive) |

**Response:**

```json
{
  "tuples": [
    { "subject": "user:alice", "relation": "viewer", "object": "doc:report", "created_at": "2024-01-15T10:30:00Z" }
  ],
  "total": 1,
  "page": 1,
  "limit": 50,
  "pages": 1
}
```

---

## Observability

### `GET /v1/health` — Health check

**No auth required.** Used by load balancers and orchestrators.

```bash
curl http://localhost:4078/v1/health
```

**Response (healthy):**

```json
{ "status": "ok", "timestamp": "2024-01-15T10:30:00.000Z", "db": "connected" }
```

**Response (degraded — DB down):**

```json
{ "status": "degraded", "timestamp": "2024-01-15T10:30:00.000Z", "db": "error" }
```

**Status Code:** `200` when healthy, `503` when degraded.

### `GET /v1/logs` — Decision audit log

Returns the last 100 authorization decisions for your tenant.

```bash
curl http://localhost:4078/v1/logs \
  -H "x-api-key: rune_sk_your_key"
```

**Response:**

```json
{
  "logs": [
    {
      "id": "a1b2c3d4-...",
      "subject": "user:arjun",
      "action": "read",
      "object": "shipment:TN001",
      "decision": "allow",
      "status": "ALLOW",
      "reason": "Access granted — valid relationship found...",
      "trace": [...],
      "suggested_fix": [],
      "latency_ms": "4.2",
      "cache_hit": false,
      "created_at": "2024-01-15T10:30:00Z"
    }
  ]
}
```

### `GET /v1/stats` — Tenant statistics

```bash
curl http://localhost:4078/v1/stats \
  -H "x-api-key: rune_sk_your_key"
```

**Response:**

```json
{
  "total_tuples": 156,
  "decisions_today": 1024,
  "allow_today": 892,
  "deny_today": 132,
  "avg_latency_ms": 3.7,
  "cache_stats": {
    "size": 48,
    "max_size": 10000,
    "indexed_keys": 12
  }
}
```

### `GET /v1/metrics` — Engine metrics (Prometheus-ready)

**No auth required.** Designed for Prometheus scraping / ops monitoring.

```bash
curl http://localhost:4078/v1/metrics
```

**Response:**

```json
{
  "total_requests": 5420,
  "total_allow": 4100,
  "total_deny": 1280,
  "total_errors": 40,
  "cache_hits": 3200,
  "cache_misses": 2220,
  "cache_hit_rate_pct": 59.04,
  "index_hits": 890,
  "latency_p50_ms": 2,
  "latency_p95_ms": 8,
  "latency_p99_ms": 15,
  "bfs_depth_histogram": [
    { "depth": 1, "count": 1200 },
    { "depth": 2, "count": 800 },
    { "depth": 3, "count": 220 }
  ],
  "window_size": 5420,
  "cache": {
    "size": 48,
    "max_size": 10000,
    "indexed_keys": 12
  },
  "pool": {
    "total": 10,
    "idle": 8,
    "waiting": 0
  }
}
```

---

## Graph Visualization

### `GET /v1/graph` — Relationship graph

Returns nodes and edges for visualization. Supports full-graph or subgraph search.

```bash
# Full graph (capped at 200 edges)
curl http://localhost:4078/v1/graph \
  -H "x-api-key: rune_sk_your_key"

# Subgraph around a specific node (3-hop BFS)
curl "http://localhost:4078/v1/graph?search=user:arjun&limit=100" \
  -H "x-api-key: rune_sk_your_key"
```

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `search` | string | — | Node ID to center the subgraph on |
| `limit` | number | `200` | Max edges returned (max 500) |

**Response:**

```json
{
  "nodes": [
    { "id": "user:arjun", "type": "user" },
    { "id": "group:chennai_managers", "type": "group" },
    { "id": "shipment:TN001", "type": "shipment" }
  ],
  "edges": [
    { "source": "user:arjun", "relation": "member", "target": "group:chennai_managers" },
    { "source": "group:chennai_managers", "relation": "viewer", "target": "shipment:TN001" }
  ],
  "total_nodes": 3,
  "total_edges": 2,
  "search": "user:arjun"
}
```

---

## Index Management

### `GET /v1/index/health` — Permission index consistency check

Samples random tuples and verifies BFS agrees with the materialized index.

```bash
curl "http://localhost:4078/v1/index/health?samples=20" \
  -H "x-api-key: rune_sk_your_key"
```

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `samples` | number | `20` | Number of tuples to check (5–50) |

**Response:**

```json
{
  "status": "ok",
  "message": "All 20 sampled permissions match between BFS and index",
  "checked": 20,
  "mismatches": 0,
  "mismatch_details": [],
  "latency_ms": 45
}
```

### `POST /v1/index/rebuild` — Rebuild permission index

Clears and rebuilds the materialized permission index from tuples.

```bash
curl -X POST http://localhost:4078/v1/index/rebuild \
  -H "Content-Type: application/json" \
  -H "x-api-key: rune_sk_your_key" \
  -d '{
    "tuples": [
      { "subject": "user:alice", "relation": "viewer", "object": "doc:report" },
      { "subject": "user:bob", "relation": "editor", "object": "doc:report" }
    ]
  }'
```

**Response:**

```json
{
  "cleared": true,
  "tuples_processed": 2,
  "indexed": 4,
  "latency_ms": 12
}
```

---

## Staleness Control (SCT)

Rune uses a **Logical Version Number (LVN)** to ensure read-after-write consistency.

Every write (`POST /v1/tuples`, `DELETE /v1/tuples`) returns an `lvn` in the response.
Pass it back in subsequent reads to guarantee the check reflects that write:

```json
// 1. Write a new tuple
POST /v1/tuples → { "success": true, "lvn": 43 }

// 2. Check permission with staleness control
POST /v1/can → { "subject": "...", "action": "...", "object": "...", "sct": { "lvn": 43 } }
```

If the engine's local LVN is behind the requested `sct.lvn`, the cache is bypassed and a fresh BFS is performed.

---

## Rate Limits

| Scope | Limit | Window |
|-------|-------|--------|
| Per API Key | 100 requests | 10 seconds |
| Per IP | 200 requests | 10 seconds |
| Admin endpoints | 20 requests | 10 seconds |

When rate-limited, the response is:

```json
{ "error": "rate_limit_exceeded" }
```

**Status Code:** `429 Too Many Requests`

---

## SDK Usage

```typescript
import { Rune } from '@runeauth/sdk'

const rune = new Rune({
  apiKey: 'rune_sk_your_key',
  baseUrl: 'http://localhost:4078',
})

// Fluent API
const result = await rune.can('user:arjun').do('read').on('shipment:TN001')
if (result.status === 'ALLOW') { /* granted */ }

// Batch check
const results = await rune.check([
  { subject: 'user:arjun', action: 'read', object: 'shipment:TN001' },
  { subject: 'user:bob', action: 'edit', object: 'doc:report' },
])

// Express middleware
app.get('/docs/:id',
  rune.protect('read', 'document:{{params.id}}'),
  handler,
)
```

The SDK automatically:
- Retries on `429` with exponential backoff
- Tracks the latest LVN and passes it as SCT
- Caches results (configurable TTL)
