/**
 * POST /v1/setup — One-time remote setup endpoint.
 *
 * Creates the database schema and generates a tenant + API key.
 * Protected by a SETUP_SECRET env var so only you can call it.
 *
 * Usage:
 *   curl -X POST https://rune-engine.onrender.com/v1/setup \
 *     -H "Content-Type: application/json" \
 *     -H "Authorization: Bearer <SETUP_SECRET>" \
 *     -d '{"tenantName": "my-app"}'
 */
import { FastifyInstance } from 'fastify'
import { resolve } from 'path'
import { pool } from '../db/client.js'
import { generateApiKey, hashKey, generateTenantId } from '../db/setup.js'
export async function setupRoute(fastify: FastifyInstance): Promise<void> {

    // Shared migration logic — drops old constraints that block custom actions/relations
    async function runMigrations(): Promise<string[]> {
        const applied: string[] = []

        // Drop old CHECK constraint on tuples.relation (if it exists)
        // This allows custom relations like 'approver', 'auditor', etc.
        try {
            await pool.query(`
                ALTER TABLE tuples DROP CONSTRAINT IF EXISTS tuples_relation_check
            `)
            applied.push('dropped tuples_relation_check constraint')
        } catch {
            // Constraint may not exist — safe to ignore
        }

        // Drop old CHECK constraint on decision_logs.decision (if it exists)
        try {
            await pool.query(`
                ALTER TABLE decision_logs DROP CONSTRAINT IF EXISTS decision_logs_decision_check
            `)
            applied.push('dropped decision_logs_decision_check constraint')
        } catch {
            // Safe to ignore
        }

        return applied
    }

    // POST /v1/migrate — run DB migrations without creating a new tenant
    fastify.post('/migrate', async (request, reply) => {
        const setupSecret = process.env['SETUP_SECRET']
        if (!setupSecret) {
            return reply.status(503).send({ error: 'SETUP_SECRET env var not set.' })
        }

        const authHeader = request.headers['authorization']
        if (!authHeader || authHeader !== `Bearer ${setupSecret}`) {
            return reply.status(401).send({ error: 'Invalid or missing Authorization header.' })
        }

        try {
            const applied = await runMigrations()
            return reply.status(200).send({ message: '✅ Migrations complete!', applied })
        } catch (err) {
            return reply.status(500).send({ error: 'Migration failed', details: (err as Error).message })
        }
    })

    fastify.post('/setup', async (request, reply) => {
        // Check for SETUP_SECRET authorization
        const setupSecret = process.env['SETUP_SECRET']
        if (!setupSecret) {
            return reply.status(503).send({
                error: 'SETUP_SECRET env var not set. Add it to Render environment variables first.',
            })
        }

        const authHeader = request.headers['authorization']
        if (!authHeader || authHeader !== `Bearer ${setupSecret}`) {
            return reply.status(401).send({ error: 'Invalid or missing Authorization header.' })
        }

        const body = request.body as { tenantName?: string }
        const tenantName = body?.tenantName?.trim() || 'default'

        try {
            // Step 0: Run migrations (drop old constraints)
            await runMigrations()

            // Step 1: Run migrations (idempotent)
            const runner = (await import('node-pg-migrate') as any).default || await import('node-pg-migrate')
            const migrationDir = resolve(process.cwd(), 'migrations')

            await runner({
                dbClient: pool,
                dir: migrationDir,
                direction: 'up',
                migrationsTable: 'pgmigrations',
                log: () => { }, // hide logs in HTTP response
            })

            // Step 2: Create tenant + API key
            const tenantId = generateTenantId()
            const apiKey = generateApiKey()
            const keyHash = hashKey(apiKey)
            const keyName = `${tenantName}-key`

            await pool.query(
                `INSERT INTO api_keys (tenant_id, key_hash, name) VALUES ($1, $2, $3)`,
                [tenantId, keyHash, keyName]
            )

            return reply.status(200).send({
                message: '✅ Setup complete!',
                tenantId,
                apiKey,
                warning: '⚠️ Save your API key — it will not be shown again.',
                quickstart: {
                    install: 'npm install @runeauth/sdk',
                    usage: `const rune = new Rune({ apiKey: '${apiKey}', baseUrl: 'https://rune-engine.onrender.com' })`,
                },
            })
        } catch (err) {
            return reply.status(500).send({
                error: 'Setup failed',
                details: (err as Error).message,
            })
        }
    })
}
