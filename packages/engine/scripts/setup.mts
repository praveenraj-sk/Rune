#!/usr/bin/env node
/**
 * rune setup — First-time setup wizard
 *
 * Run from the rune/ root:
 *   node --loader tsx packages/engine/scripts/setup.mts
 *   OR
 *   pnpm setup
 *
 * Interactive CLI that:
 * 1. Verifies DB connection
 * 2. Runs the schema (idempotent — safe to re-run)
 * 3. Creates a new tenant + API key
 * 4. Prints the key and a quickstart snippet
 */
import { createHash, randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { createInterface } from 'readline'
import { resolve } from 'path'
import { config as loadEnv } from 'dotenv'
import pkg from 'pg'

const { Pool } = pkg

// pnpm exec runs from packages/engine/ — project root is ../../
// But NODE_ENV aware: also check for DATABASE_URL already in env
const projectRoot = resolve(process.cwd(), '../..')
loadEnv({ path: resolve(projectRoot, '.env'), override: true })

// ── Colours ───────────────────────────────────────────────────────────────────
const c = {
    green: (s: string) => `\x1b[32m${s}\x1b[0m`,
    blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
    yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
    red: (s: string) => `\x1b[31m${s}\x1b[0m`,
    bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
    dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
}

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res))

function generateApiKey(): string {
    return `rune_${randomBytes(24).toString('base64url')}`
}

function hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex')
}

function generateTenantId(): string {
    const b = randomBytes(16)
    b[6] = (b[6]! & 0x0f) | 0x40
    b[8] = (b[8]! & 0x3f) | 0x80
    const hex = b.toString('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function main(): Promise<void> {
    console.log()
    console.log(c.bold(c.blue('  🌿 Rune — First-time Setup')))
    console.log(c.dim('  ─────────────────────────────────────'))
    console.log()

    // Step 1: Get DATABASE_URL
    const dbUrl = process.env['DATABASE_URL']
    if (!dbUrl) {
        console.error(c.red('  ✗ DATABASE_URL not set.'))
        console.error(c.dim('  Copy .env.example → .env and set DATABASE_URL, then run again.'))
        process.exit(1)
    }
    console.log(c.dim('  Using DATABASE_URL from environment'))

    // Step 2: Connect to DB
    process.stdout.write('  Connecting to database... ')
    const pool = new Pool({ connectionString: dbUrl })
    try {
        await pool.query('SELECT 1')
        console.log(c.green('✓'))
    } catch (err) {
        console.log(c.red('✗'))
        console.error(c.red(`  Error: ${(err as Error).message}`))
        console.error(c.dim('  Is the database running? Check podman-compose up -d'))
        process.exit(1)
    }

    // Step 3: Run schema (idempotent)
    process.stdout.write('  Applying database schema... ')
    try {
        const schemaPath = resolve(process.cwd(), 'src/db/schema.sql')
        const schema = readFileSync(schemaPath, 'utf8')
        await pool.query(schema)
        console.log(c.green('✓'))
    } catch (err) {
        console.log(c.red('✗'))
        console.error(c.red(`  Error: ${(err as Error).message}`))
        process.exit(1)
    }

    // Step 4: Tenant name
    console.log()
    const tenantName = ((await ask('  Tenant name (e.g. "acme" or "my-app"): ')).trim()) || 'default'
    const tenantId = generateTenantId()

    // Step 5: Create API key
    const apiKey = generateApiKey()
    const keyHash = hashKey(apiKey)
    const keyName = `${tenantName}-key`

    await pool.query(
        `INSERT INTO api_keys (tenant_id, key_hash, name) VALUES ($1, $2, $3)`,
        [tenantId, keyHash, keyName]
    )
    await pool.end()

    // Step 6: Print result
    console.log()
    console.log(c.bold(c.green('  ✓ Setup complete!')))
    console.log()
    console.log(`  ${c.bold('Tenant ID')}  ${tenantId}`)
    console.log(`  ${c.bold('API Key')}  ${c.yellow(c.bold(apiKey))}`)
    console.log()
    console.log(c.dim('  ⚠️  Save your API key — it will not be shown again.'))
    console.log()
    console.log(c.bold('  Quickstart:'))
    console.log()
    console.log(`  ${c.dim('npm install @rune/sdk')}`)
    console.log()
    console.log(`  ${c.green('const rune = new Rune({ apiKey: \'' + apiKey + '\', baseUrl: \'http://localhost:3001\' })')}`)
    console.log(`  ${c.green('await rune.allow({ subject: \'user:alice\', relation: \'viewer\', object: \'doc:report\' })')}`)
    console.log(`  ${c.green('const r = await rune.can(\'user:alice\').do(\'read\').on(\'doc:report\')')}`)
    console.log(`  ${c.green('console.log(r.status) // "ALLOW"')}`)
    console.log()
    console.log(c.dim('  ─────────────────────────────────────'))
    console.log()

    rl.close()
}

main().catch((err) => {
    console.error(c.red(`\n  Fatal: ${(err as Error).message}\n`))
    process.exit(1)
})
