# Testing Guide

## Overview

| Suite | Command | Tests | What it covers |
|---|---|---|---|
| Engine (all) | `pnpm test` | 164 | Unit + integration |
| Engine (security) | `pnpm test:security` | 10 | Attack scenarios |
| SDK | `pnpm test:sdk` | 30 | Client API |
| All | `pnpm test:all` | 194 | Everything |
| Typecheck | `pnpm run typecheck` | — | TypeScript errors |

---

## Prerequisites

Before running tests, Postgres must be running:

```bash
docker compose up -d
```

Tests automatically:
- Load `.env` via `tests/setup.ts`
- Seed test API keys into `api_keys` table
- Clean up test data before each test (`beforeEach`)

---

## Running Tests

### Run everything (recommended before any commit)
```bash
pnpm test:all && pnpm run typecheck
```

### Engine tests only
```bash
cd packages/engine
pnpm exec vitest run
```

### Watch mode (re-runs on file save)
```bash
cd packages/engine
pnpm exec vitest
```

### Security tests only
```bash
pnpm test:security
# or
cd packages/engine && pnpm exec vitest run tests/integration/security.test.ts
```

### SDK tests
```bash
pnpm test:sdk
# or
cd packages/sdk && pnpm exec vitest run
```

---

## Test Structure (Engine)

```
packages/engine/tests/
├── setup.ts                        # Global: loads .env, seeds test API keys, sets JWT_SECRET + JWKS_URI
├── fixtures/
│   └── tuples.ts                   # Reusable tenant + tuple data
├── helpers/
│   └── test-app.ts                 # Shared Fastify test app factory
├── integration/
│   ├── routes.test.ts              # HTTP route tests (11 tests)
│   ├── security.test.ts            # Attack scenarios (10 tests)
│   ├── regression.test.ts          # Decision corpus — ALLOW/DENY/NOT_FOUND contracts (22 tests)
│   ├── tenant-isolation.test.ts    # Cross-tenant data leakage prevention (7 tests)
│   ├── contract.test.ts            # API response shape contracts (8 tests)
│   ├── jwt.test.ts                 # JWT HS256 + attack vectors (10 tests)
│   └── latency.test.ts             # P99 < 20ms gate on cached path (2 tests)
└── unit/
    ├── bfs.test.ts                 # BFS traversal (8 tests)
    ├── can.test.ts                 # Authorization decisions (7 tests)
    ├── cache.test.ts               # LRU cache (10 tests)
    ├── chaos.test.ts               # DB failure → fail closed (6 tests)
    ├── db.test.ts                  # Database queries (18 tests)
    ├── failures.test.ts            # Error handling (8 tests)
    ├── jwks.test.ts                # JWKS/RS256 key cache + attack vectors (14 tests)
    ├── observability.test.ts       # Metrics + logging (11 tests)
    └── permission-index.test.ts    # O(1) index reads/writes (12 tests)
```

---

## Security Tests (ATTACKS 1–10)

These are critical. All 10 must pass:

| Attack | What it tests |
|---|---|
| ATTACK 1 | Tenant isolation — T1 key can't see T2 data |
| ATTACK 2 | Subject injection rejected by tenant scope |
| ATTACK 3 | Invalid relation rejected at route level (400) |
| ATTACK 4 | Missing API key → 401 |
| ATTACK 5 | Invalid API key → 401 |
| ATTACK 6 | BFS depth bomb (25-level chain) → DENY |
| ATTACK 7 | BFS width bomb (1001 fan-out) → DENY |
| ATTACK 8 | Circular relationships complete without hanging |
| ATTACK 9 | Empty subject blocked by schema validation (400) |
| ATTACK 10 | Stack traces never exposed in error responses |

---

## Writing New Tests

### Integration test pattern

```ts
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { query } from '../../src/db/client.js'
import { cache } from '../../src/cache/lru.js'
import { LOGISTICS_TENANT } from '../fixtures/tuples.js'
import { createTestApp } from '../helpers/test-app.js'

const TEST_API_KEY = 'rune-test-key-1234567890'  // pre-seeded by setup.ts
const app = createTestApp()

beforeAll(async () => { await app.ready() })
afterAll(async () => { await app.close() })

beforeEach(async () => {
  // always clean fixture data before each test
  await query('DELETE FROM tuples WHERE tenant_id = $1', [LOGISTICS_TENANT])
  cache.deleteByTenant(LOGISTICS_TENANT)
})

describe('My feature', () => {
  test('does the thing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/can',
      headers: { 'x-api-key': TEST_API_KEY },
      payload: { subject: 'user:arjun', action: 'read', object: 'shipment:TN001' },
    })
    expect(res.statusCode).toBe(200)
  })
})
```

### Rules
- Always use `beforeEach` to clean data — never assume a clean state
- Use `ON CONFLICT DO NOTHING` for setup inserts so tests are idempotent
- Never `await` `logDecision` — it's fire-and-forget by design (tests will see warnings, that's expected)
- Use `app.inject()` — never open a real HTTP port in tests

---

## CI / typecheck

Run before every push:

```bash
pnpm test:all         # all 194 tests must pass
pnpm run typecheck    # TypeScript must compile clean
```

If `pnpm test:all` fails on a fresh clone, reset the database:

```bash
docker compose down -v
docker compose up -d
# Re-run tests — setup.ts seeds everything automatically
pnpm test:all
```
