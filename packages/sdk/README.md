# @runeauth/sdk

Zero-dependency Node.js client for [Rune](https://github.com/praveenraj-sk/Rune) — a relationship-based authorization engine (ReBAC).

```bash
npm install @runeauth/sdk
```

Requires **Node.js ≥ 18**.

---

## What is Rune?

Rune answers one question: **can this user do this action on this resource?**

It works by traversing a graph of relationships (tuples) you define — like Google Zanzibar. Instead of hardcoding permission logic, you store relationships in Rune and query them at runtime.

```
user:arjun  →  member  →  group:managers  →  owner  →  zone:chennai  →  viewer  →  shipment:TN001
```

If a valid path exists → `ALLOW`. If not → `DENY`.

---

## Prerequisites

You need a running Rune engine. Two options:

### Option A — Use the hosted cloud engine (easiest)

No setup needed! Use the public Render deployment:

```
Base URL: https://rune-engine.onrender.com
```

Ask the project owner for an API key.

### Option B — Run locally

```bash
git clone https://github.com/praveenraj-sk/Rune.git
cd Rune
pnpm install
docker compose up -d     # starts Postgres
cp .env.example .env
pnpm run setup           # creates your API key
pnpm dev                 # engine starts at http://localhost:4078
```

---

## Quickstart

```ts
import { Rune } from '@runeauth/sdk'

const rune = new Rune({
  apiKey:  process.env.RUNE_API_KEY!,
  baseUrl: 'https://rune-engine.onrender.com',  // or http://localhost:4078 for local
})

// Fluent API
const result = await rune.can('user:arjun').do('read').on('shipment:TN001')
console.log(result.status)   // 'ALLOW' | 'DENY' | 'NOT_FOUND'
console.log(result.decision) // 'allow' | 'deny'
console.log(result.trace)    // shows the path that was traversed
```

---

## API Reference

### `new Rune(config)`

```ts
const rune = new Rune({
  apiKey:   'your-api-key',          // required
  baseUrl:  'http://localhost:4078', // required — your engine URL
  timeout:  5000,                    // optional — ms, default 5000
})
```

---

### `rune.can(subject).do(action).on(object)` — Fluent API

Check if a subject can perform an action on an object.

```ts
const result = await rune.can('user:arjun').do('read').on('shipment:TN001')
```

**Actions:** `'read'` | `'edit'` | `'delete'` | `'manage'`

**Response:**
```ts
{
  decision:     'allow' | 'deny',
  status:       'ALLOW' | 'DENY' | 'NOT_FOUND',
  reason:       string,         // plain English explanation
  trace:        TraceNode[],    // path traversed in the graph
  suggested_fix: string[],      // how to grant access (if DENY)
  cache_hit:    boolean,
  latency_ms:   number,
  sct:          { lvn: number } // logical version number for cache freshness
}
```

---

### `rune.check(params)` — Direct API

Same as the fluent API but as a single call:

```ts
const result = await rune.check({
  subject: 'user:arjun',
  action:  'read',
  object:  'shipment:TN001',
})
```

---

### `rune.allow(grant)` — Add a relationship

```ts
await rune.allow({
  subject:  'user:arjun',
  relation: 'member',        // 'owner' | 'editor' | 'viewer' | 'member'
  object:   'group:managers',
})
```

---

### `rune.revoke(grant)` — Remove a relationship

```ts
await rune.revoke({
  subject:  'user:arjun',
  relation: 'member',
  object:   'group:managers',
})
```

---

### `rune.logs()` — Recent decisions

```ts
const { logs } = await rune.logs()
// logs: array of recent allow/deny decisions for your tenant
```

---

### `rune.health()` — Engine health

```ts
const health = await rune.health()
// { status: 'ok' | 'degraded', db: 'connected' | 'error', timestamp: string }
```

---

## Real-world Example — Express middleware

```ts
import express from 'express'
import { Rune } from '@runeauth/sdk'

const rune = new Rune({
  apiKey:  process.env.RUNE_API_KEY!,
  baseUrl: process.env.RUNE_URL!,     // e.g. http://localhost:4078
})

// Protect a route
app.get('/shipments/:id', async (req, res) => {
  const permission = await rune
    .can(`user:${req.user.id}`)
    .do('read')
    .on(`shipment:${req.params.id}`)

  if (permission.status !== 'ALLOW') {
    return res.status(403).json({ error: 'Access denied', hint: permission.suggested_fix })
  }

  const shipment = await db.getShipment(req.params.id)
  res.json(shipment)
})
```

---

## Error Handling

The SDK throws `RuneError` for HTTP errors:

```ts
import { Rune, RuneError } from '@runeauth/sdk'

try {
  const permission = await rune.can('user:arjun').do('read').on('shipment:TN001')
} catch (err) {
  if (err instanceof RuneError) {
    console.error(err.statusCode) // 401, 403, 500...
    console.error(err.message)    // human readable
  }
}
```

---

## SCT — Stale Cache Token (advanced)

If you need read-your-writes consistency after adding a relationship:

```ts
const { lvn } = await rune.allow({ subject: 'user:arjun', relation: 'viewer', object: 'doc:123' })

// Pass the lvn back to bypass cache for this check
const permission = await rune.can('user:arjun').do('read').on('doc:123', { sct: { lvn } })
```

---

## TypeScript

Fully typed. All types are exported:

```ts
import type { Permission, Grant, HealthStatus, Action } from '@runeauth/sdk'
```

---

## License

MIT — [github.com/praveenraj-sk/Rune](https://github.com/praveenraj-sk/Rune)
