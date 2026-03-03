/**
 * Global test setup for all engine tests.
 * Runs before each test file.
 *
 * IMPORTANT — ESM import hoisting:
 * Static `import` statements are hoisted BEFORE any code runs.
 * db/client.ts → imports config/index.ts → reads DATABASE_URL immediately.
 * If dotenv hasn't run yet, config validation fails with process.exit(1).
 *
 * Fix: use dynamic `await import()` for any module that reads process.env,
 * so they execute AFTER dotenv has loaded the .env file.
 */
import { config } from 'dotenv'
import { createHash } from 'crypto'

// MUST run before any dynamic import — loads DATABASE_URL into process.env
config({ path: '../../.env', override: true })

if (!process.env['DATABASE_URL']) {
    throw new Error(
        'DATABASE_URL is not set. Copy .env.example to .env and configure it.\n' +
        'Run: cp ../../.env.example ../../.env'
    )
}

// ── Seed test API keys ────────────────────────────────────────────────────────
// Dynamic imports run AFTER dotenv — safe to use process.env here.
// Integration tests use hardcoded raw keys. We hash them exactly as auth.ts
// does (plain SHA-256) and ensure they exist in the DB before tests run.
// ON CONFLICT DO NOTHING makes this fully idempotent.
const { query } = await import('../src/db/client.js')
const { LOGISTICS_TENANT, HOSPITAL_TENANT } = await import('./fixtures/tuples.js')

const TEST_KEYS = [
    { rawKey: 'rune-test-key-1234567890', tenantId: LOGISTICS_TENANT, name: 'test-key-logistics' },
    { rawKey: 'rune-test-key-hospital', tenantId: HOSPITAL_TENANT, name: 'test-key-hospital' },
]

for (const { rawKey, tenantId, name } of TEST_KEYS) {
    const keyHash = createHash('sha256').update(rawKey).digest('hex')
    await query(
        `INSERT INTO api_keys (tenant_id, key_hash, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (key_hash) DO NOTHING`,
        [tenantId, keyHash, name]
    )
}
