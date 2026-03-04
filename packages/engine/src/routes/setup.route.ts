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
import { createHash, randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { pool } from '../db/client.js'

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

export async function setupRoute(fastify: FastifyInstance): Promise<void> {
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
            // Step 1: Run schema (idempotent)
            const schemaPath = resolve(process.cwd(), 'src/db/schema.sql')
            let schema: string
            try {
                schema = readFileSync(schemaPath, 'utf8')
            } catch {
                // In Docker, dist is at /app/packages/engine/dist, but src is also copied
                // Try relative to __dirname
                const altPath = resolve(new URL('.', import.meta.url).pathname, '../../src/db/schema.sql')
                schema = readFileSync(altPath, 'utf8')
            }
            await pool.query(schema)

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
