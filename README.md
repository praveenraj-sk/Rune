<div align="center">

# Rune

**Relationship-based authorization engine.**<br>
Add fine-grained, graph-traversal permissions to your app in minutes.

[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@runeauth/sdk?color=black)](https://www.npmjs.com/package/@runeauth/sdk)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A518-black.svg)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Fpraveenraj--sk%2Frune-black.svg)](https://ghcr.io/praveenraj-sk/rune)

*"Can user:arjun read shipment:TN001?"*<br>
Rune traces the graph — user → group → zone → resource — and returns ALLOW or DENY with a full explanation.

</div>

---

## Why Rune?

| | |
|---|---|
| 🔀 **ReBAC + RBAC + ABAC** | All three models in one engine — set `mode` per resource in `rune.config.yml` |
| ⚡ **< 5ms decisions** | LRU cache + O(1) permission index — most checks never hit the DB |
| 🔍 **Full explainability** | Every decision includes a trace, reason, and suggested fix |
| 🔒 **Fail-closed** | Errors return DENY, never ALLOW. Keys are SHA-256 hashed. |
| 🏢 **Multi-tenant** | Every query is scoped to `tenant_id` — zero cross-tenant leakage |
| 🔗 **Zero-Sync** | Read from your existing Postgres/MySQL tables — no separate tuple store needed |
| 🖥️ **Admin Dashboard** | Built-in UI — manage relationships, view decision logs, test permissions live |
| 📦 **Zero-dep SDK** | Native `fetch` only — built-in circuit breaker & retry |

---

## Quickstart — 1 minute, no source code needed

**Step 1: Start the engine + Postgres**

```bash
curl -O https://raw.githubusercontent.com/praveenraj-sk/Rune/main/docker-compose.prod.yml
docker compose -f docker-compose.prod.yml up -d
# → engine running at http://localhost:4078
```

**Step 2: Install the SDK**

```bash
npm install @runeauth/sdk
```

Done. Default API key: `rune-dev-key` (change before production).

---

### Contributing / local dev

```bash
git clone https://github.com/praveenraj-sk/Rune.git && cd Rune
cp .env.example .env   # set DATABASE_URL
docker compose up -d   # Postgres only (build: .)
pnpm install && pnpm dev
```

---

## SDK — 3 lines to check access

```bash
npm install @runeauth/sdk
```

```ts
import { Rune } from '@runeauth/sdk'

const rune = new Rune({
  apiKey:  process.env.RUNE_API_KEY!,
  baseUrl: 'http://localhost:4078',
})

// Grant access
await rune.allow({ subject: 'user:alice', relation: 'viewer', object: 'doc:report' })

// Check access
const result = await rune.can('user:alice').do('read').on('doc:report')
// → { status: 'ALLOW', trace: [...], latency_ms: 2.1 }

// Revoke access
await rune.revoke({ subject: 'user:alice', relation: 'viewer', object: 'doc:report' })
```

---

## How it works

```
user:arjun  ──member──▸  group:chennai_mgrs  ──owner──▸  zone:chennai  ──viewer──▸  shipment:TN001
                                                                                         ↓
                                                                                    ✅ ALLOW
```

Rune supports **ReBAC, RBAC, ABAC, and Hybrid** — set `mode` per resource in `rune.config.yml`. For ReBAC resources, Rune traces the graph via BFS to resolve access.

| Relation | read | edit | delete | manage |
|---|:---:|:---:|:---:|:---:|
| `owner` | ✅ | ✅ | ✅ | ✅ |
| `editor` | ✅ | ✅ | ✅ | ❌ |
| `viewer` | ✅ | ❌ | ❌ | ❌ |
| `member` | → | → | → | → |

`member` is a traversal relation — it doesn't grant access, but lets BFS continue through groups and zones.

---

## Documentation

| Guide | What's inside |
|---|---|
| [SDK Guide](docs/SDK-GUIDE.md) | Full API reference, Express/Fastify integration, error handling |
| [API Reference](docs/API.md) | HTTP endpoints — `POST /v1/can`, `/v1/tuples`, etc. |
| [Architecture](docs/ARCHITECTURE.md) | BFS algorithm, data model, caching, security design |
| [Deploy Guide](docs/DEPLOY.md) | Deploy to Render with Postgres |
| [Development](docs/DEVELOPMENT.md) | Local setup, env vars, project structure |
| [Testing](docs/TESTING.md) | Running tests, writing tests, security attack suite |
| [Contributing](CONTRIBUTING.md) | Branch naming, commit style, PR checklist |
| [Security](SECURITY.md) | How to report vulnerabilities |

---

## Project structure

```
rune/
├── packages/
│   ├── engine/          # Fastify v5 API server (TypeScript)
│   │   └── src/
│   │       ├── server.ts      # Entry point
│   │       ├── bfs/           # BFS graph traversal
│   │       ├── cache/         # LRU cache with O(k) invalidation
│   │       ├── config/        # Env validation (Zod)
│   │       ├── db/            # Postgres pool + migrations
│   │       ├── engine/        # can() decision function + explainability
│   │       ├── middleware/    # Auth, admin-only, rate-limit
│   │       ├── routes/        # /can, /tuples, /health, /logs, /admin
│   │       └── dashboard/     # Built-in admin UI (HTML/CSS/JS)
│   ├── core/            # @runeauth/core — embeddable engine (no server needed)
│   │   └── src/
│   │       ├── engine.ts      # RuneEngine — mode routing (rebac/rbac/abac/hybrid)
│   │       ├── bfs.ts         # Portable BFS traversal
│   │       ├── conditions.ts  # ABAC condition evaluator
│   │       ├── policy.ts      # Role inheritance resolver
│   │       ├── datasource/    # Zero-Sync SQL adapter (Postgres/MySQL/SQLite)
│   │       └── store/         # TupleStore interface + MemoryStore
│   ├── sdk/             # @runeauth/sdk — zero-dep HTTP client
│   └── cli/             # rune init / validate / explain / index tools
├── docs/                # All documentation
├── rune.config.yml      # Authorization policy (modes, roles, conditions, datasources)
├── docker-compose.yml   # Local Postgres
└── .env.example         # Copy to .env to get started
```

---

## Tests

```bash
pnpm test          # Engine (101 tests, requires Postgres)
pnpm test:sdk      # SDK (30 tests)
cd packages/core && pnpm test  # Core (39 tests)
```

**170 tests** across 3 packages — unit, integration, security attack suite, chaos, and observability.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection string (required) |
| `PORT` | `4078` | Engine HTTP port |
| `NODE_ENV` | `development` | `development` or `production` |
| `API_KEY_SALT` | — | Extra salt for API key hashing |
| `ADMIN_API_KEY` | — | Enables `/admin` dashboard |
| `MAX_CACHE_SIZE` | `10000` | Max LRU cache entries |
| `MAX_BFS_DEPTH` | `20` | Max graph traversal depth |
| `MAX_BFS_NODES` | `1000` | Max nodes visited per check |
| `RATE_LIMIT_MAX` | `100` | Requests per key per window |
| `RATE_LIMIT_WINDOW_MS` | `10000` | Rate limit window (ms) |

See [.env.example](.env.example) for a ready-to-use template.

---

## License

[MIT](LICENSE) © Praveen Raj
