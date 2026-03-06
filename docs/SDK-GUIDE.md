# SDK Guide — @runeauth/sdk

Comprehensive guide to using the Rune SDK in your applications.

Install:
```bash
npm install @runeauth/sdk   # v2.2.3
```

Requires **Node.js ≥ 18**. Zero external dependencies.

---

## Setup

```ts
import { Rune } from '@runeauth/sdk'

const rune = new Rune({
  apiKey:  process.env.RUNE_API_KEY!,   // from pnpm run setup
  baseUrl: process.env.RUNE_URL!,       // e.g. http://localhost:4078
  timeout: 5000,                        // optional, default 5000ms
})
```

Store these in your app's `.env`:
```env
RUNE_API_KEY=rune_xxxxxxxxxxxxxxxxxxxx
RUNE_URL=http://localhost:4078
```

---

## Checking Permissions

### Fluent API (recommended)

```ts
const result = await rune.can('user:arjun').do('read').on('shipment:TN001')
```

### Direct API

```ts
const result = await rune.check({
  subject: 'user:arjun',
  action:  'read',
  object:  'shipment:TN001',
})
```

### Actions

| Action | Meaning |
|---|---|
| `read` | View / read-only access |
| `edit` | Read + write access |
| `delete` | Can delete the resource |
| `manage` | Full control (owner-level) |

### Response

```ts
{
  decision:      'allow' | 'deny',
  status:        'ALLOW' | 'DENY' | 'NOT_FOUND',
  reason:        string,         // plain English: why was decision made?
  trace:         TraceNode[],    // nodes visited in the graph
  suggested_fix: string[],       // how to grant access (on DENY)
  cache_hit:     boolean,
  latency_ms:    number,
  sct:           { lvn: number }
}
```

**Status values:**
- `ALLOW` — subject has permission
- `DENY` — subject exists but no valid path found
- `NOT_FOUND` — the resource object doesn't exist in the relationship graph at all

---

## Managing Relationships (Tuples)

### Relations

| Relation | Meaning |
|---|---|
| `owner` | Full control |
| `editor` | Read + write |
| `viewer` | Read-only |
| `member` | Group membership (used for traversal) |

### Add a relationship

```ts
// Give arjun viewer access to a document
await rune.allow({
  subject:  'user:arjun',
  relation: 'viewer',
  object:   'doc:report-2024',
})

// Add arjun to a group
await rune.allow({
  subject:  'user:arjun',
  relation: 'member',
  object:   'group:engineering',
})
```

### Remove a relationship

```ts
await rune.revoke({
  subject:  'user:arjun',
  relation: 'viewer',
  object:   'doc:report-2024',
})
```

---

## Relationship Graph

Rune uses **BFS (Breadth-First Search)** to traverse the relationship graph.
Relationships form chains — permissions are inherited through `member` relations.

```
user:arjun
  → member → group:managers
                → owner → zone:chennai
                            → viewer → shipment:TN001
```

When you ask `can('user:arjun').do('read').on('shipment:TN001')`, Rune:
1. Starts at `user:arjun`
2. Follows all relationships (BFS, level by level)
3. Checks if any path reaches `shipment:TN001` via a valid relation for `read`
4. Returns `ALLOW` if found, `DENY` if not

---

## Suggested Fix (DENY explainability)

When a decision is `DENY`, the `suggested_fix` field tells you how to grant access:

```ts
const result = await rune.can('user:bob').do('read').on('shipment:TN001')

if (result.status === 'DENY') {
  console.log(result.reason)
  // "No valid relationship found between user:bob and shipment:TN001 for action: read"

  console.log(result.suggested_fix)
  // ["Add user:bob to group:chennai_managers to gain read access",
  //  "Or assign user:bob as viewer on shipment:TN001 directly"]
}
```

Show this to admins to help them fix access issues.

---

## Cache Freshness — SCT Token

Rune caches decisions in an LRU cache. After you write a new relationship,
there's a brief window where the cache might serve the old (stale) decision.

For **read-your-writes consistency** after adding a relationship, use the SCT token:

```ts
// Add a tuple — returns the current LVN (Logical Version Number)
const { lvn } = await rune.allow({
  subject:  'user:newuser',
  relation: 'viewer',
  object:   'doc:secret',
})

// Pass lvn to bypass cache for this specific check
const result = await rune
  .can('user:newuser')
  .do('read')
  .on('doc:secret', { sct: { lvn } })

// result will always reflect the just-added tuple
```

For most use cases, you don't need SCT — cache invalidation is automatic on every write.

---

## Health Check

```ts
const health = await rune.health()
// { status: 'ok', db: 'connected', timestamp: '...' }
// { status: 'degraded', db: 'error', timestamp: '...' }  ← Postgres is down
```

Uses the same timeout and circuit-breaker as all other SDK calls — if the engine hangs and doesn't respond within `timeout` ms, a `RuneError` with `statusCode: 408` is thrown.

Use this in your app startup or monitoring:

```ts
const health = await rune.health()
if (health.status !== 'ok') {
  throw new Error('Rune engine is unavailable')
}
```

---

## Decision Logs

Rune logs every `can()` decision. Retrieve recent logs for your tenant:

```ts
const { logs } = await rune.logs()

for (const log of logs) {
  console.log(`${log.subject} tried to ${log.action} ${log.object} → ${log.status}`)
}
```

Each log entry:
```ts
{
  id:         string    // decision ID
  subject:    string
  action:     string
  object:     string
  decision:   'allow' | 'deny'
  status:     'ALLOW' | 'DENY' | 'NOT_FOUND'
  reason:     string | null
  latency_ms: number
  cache_hit:  boolean
  created_at: string    // ISO timestamp
}
```

---

## Error Handling

```ts
import { Rune, RuneError } from '@runeauth/sdk'

try {
  const result = await rune.can('user:arjun').do('read').on('shipment:TN001')
} catch (err) {
  if (err instanceof RuneError) {
    // HTTP-level errors from the engine
    console.error(err.statusCode)   // 401, 408, 429, 500...
    console.error(err.message)
    // 401 → invalid or missing API key
    // 408 → request timed out (engine unreachable or too slow)
    // 429 → rate limit exceeded — back off and retry after a short delay
    // 500 → engine internal error
  } else {
    // Network error (ECONNREFUSED — engine not running)
    console.error('Engine is unreachable:', err)
  }
}
```

---

## Framework Integrations

### Express middleware

```ts
import express from 'express'
import { Rune } from '@runeauth/sdk'

const rune = new Rune({
  apiKey:  process.env.RUNE_API_KEY!,
  baseUrl: process.env.RUNE_URL!,
})

function requirePermission(action: string, getObject: (req: express.Request) => string) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const result = await rune
      .can(`user:${req.user.id}`)
      .do(action as any)
      .on(getObject(req))

    if (result.status !== 'ALLOW') {
      return res.status(403).json({
        error:    'Access denied',
        reason:   result.reason,
        hint:     result.suggested_fix,
      })
    }
    next()
  }
}

// Usage
app.get(
  '/shipments/:id',
  requirePermission('read', req => `shipment:${req.params.id}`),
  async (req, res) => {
    const shipment = await db.getShipment(req.params.id)
    res.json(shipment)
  }
)
```

### Fastify

```ts
import Fastify from 'fastify'
import { Rune } from '@runeauth/sdk'

const rune = new Rune({ apiKey: process.env.RUNE_API_KEY!, baseUrl: process.env.RUNE_URL! })
const app = Fastify()

app.addHook('preHandler', async (request, reply) => {
  const routeConfig = request.routeOptions.config as { resource?: string; action?: string }
  if (!routeConfig.resource) return

  const result = await rune
    .can(`user:${request.user.id}`)
    .do(routeConfig.action ?? 'read')
    .on(routeConfig.resource)

  if (result.status !== 'ALLOW') {
    reply.status(403).send({ error: 'Access denied' })
  }
})
```

---

## TypeScript Types

All types are exported:

```ts
import type {
  RuneOptions,    // constructor options
  Permission,     // response from can() / check()
  Grant,          // input to allow() / revoke()
  GrantResult,    // response from allow() / revoke()
  AuditLog,       // response from logs()
  HealthStatus,   // response from health()
  Action,         // 'read' | 'edit' | 'delete' | 'manage'
} from '@runeauth/sdk'
```
