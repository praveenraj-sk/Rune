<div align="center">

# Rune

**Relationship-based authorization engine.**<br>
Add fine-grained, graph-traversal permissions to your app in minutes.

[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@runeauth/sdk?color=black)](https://www.npmjs.com/package/@runeauth/sdk)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A518-black.svg)](https://nodejs.org)

*"Can user:arjun read shipment:TN001?"*<br>
Rune traces the graph — user → group → zone → resource — and returns ALLOW or DENY with a full explanation.

</div>

---

## Why Rune?

| | |
|---|---|
| 🔀 **Graph traversal** | Permissions flow through relationships — BFS finds the path |
| ⚡ **< 5ms decisions** | LRU cache + permission index means most checks never hit the DB |
| 🔍 **Full explainability** | Every decision includes a trace, reason, and suggested fix |
| 🔒 **Fail-closed** | Errors return DENY, never ALLOW. Keys are SHA-256 hashed. |
| 🏢 **Multi-tenant** | Every query is scoped to `tenant_id` — zero cross-tenant leakage |
| 📦 **Zero-dep SDK** | Native `fetch` only — built-in circuit breaker & retry |

---

## Quickstart

```bash
# 1. Clone & install
git clone https://github.com/praveenraj-sk/Rune.git && cd Rune
pnpm install

# 2. Start Postgres
docker compose up -d

# 3. Configure
cp .env.example .env

# 4. Create schema + first API key
pnpm run setup

# 5. Start the engine
pnpm dev
# → http://localhost:4078
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

Rune uses **Relationship-Based Access Control (ReBAC)**. You define *who has what relationship to what*, and Rune traces the graph via BFS to resolve access.

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
│   │       ├── db/            # Postgres pool + schema + migrations
│   │       ├── engine/        # can() decision function + explainability
│   │       ├── middleware/    # Auth, admin-only, rate-limit
│   │       ├── routes/        # /can, /tuples, /health, /logs, /admin
│   │       └── dashboard/     # Built-in admin UI
│   ├── core/            # @runeauth/core — embeddable engine (no server needed)
│   └── sdk/             # @runeauth/sdk — zero-dep HTTP client
├── docs/                # All documentation
├── site/                # Landing page (GitHub Pages)
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
