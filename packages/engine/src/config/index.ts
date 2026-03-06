/**
 * Central config module — ALL environment variables are read here.
 * No other file may read process.env directly.
 *
 * Validates config at startup using zod.
 * If any required var is missing → process.exit(1)
 * (zod is allowed in the engine package; zero-dep rule applies to SDK only)
 */
import { z } from 'zod'
import { createHash } from 'crypto'

const configSchema = z.object({
    server: z.object({
        port: z.number().min(1).max(65535).default(4078),
        nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
    }),
    db: z.object({
        url: z.string().min(1, 'DATABASE_URL is required'),
        poolMax: z.number().default(10),
        poolMin: z.number().default(2),
    }),
    cache: z.object({
        maxSize: z.number().default(10000),
    }),
    bfs: z.object({
        maxDepth: z.number().min(1, 'MAX_BFS_DEPTH must be at least 1 — setting 0 denies every permission check').default(20),
        maxNodes: z.number().min(1, 'MAX_BFS_NODES must be at least 1 — setting 0 denies every permission check').default(1000),
    }),
    security: z.object({
        apiKeySalt: z.string().min(32, 'API_KEY_SALT must be at least 32 characters'),
    }),
    rateLimit: z.object({
        maxRequests: z.number().default(100),
        windowMs: z.number().default(10000),
    }),
    admin: z.object({
        /** SHA-256 hash of ADMIN_API_KEY env var. Empty string = admin dashboard disabled. */
        apiKeyHash: z.string().default(''),
    }),
})

export type Config = z.infer<typeof configSchema>

function loadConfig(): Config {
    const nodeEnv = process.env['NODE_ENV'] ?? 'development'
    const isProduction = nodeEnv === 'production'

    // ── API_KEY_SALT enforcement ─────────────────────────────────────────────
    // In production: MUST be set — server refuses to start without it.
    // The default salt is public (it's in the GitHub repo), so using it in
    // production means any DB dump is instantly reversible by an attacker.
    //
    // In dev/test: allowed to fall back to the default so the server starts
    // without a .env file. A loud warning is printed so it's never missed.
    const apiKeySalt = process.env['API_KEY_SALT']

    if (!apiKeySalt) {
        if (isProduction) {
            console.error(
                '\n🚨 FATAL: API_KEY_SALT environment variable is not set.\n' +
                '   This server will NOT start in production without a secure salt.\n' +
                '   Generate one with: openssl rand -hex 32\n' +
                '   Then set it in your deployment environment (Render, Railway, etc.).\n'
            )
            process.exit(1)
        } else {
            console.warn(
                '\n⚠️  WARNING: API_KEY_SALT is not set — using insecure default salt.\n' +
                '   This is fine for local development, but MUST be set before deploying.\n' +
                '   Generate one: openssl rand -hex 32\n'
            )
        }
    }

    const adminKey = process.env['ADMIN_API_KEY'] ?? ''
    const adminKeyHash = adminKey
        ? createHash('sha256').update(adminKey).digest('hex')
        : ''

    const result = configSchema.safeParse({
        server: {
            port: parseInt(process.env['PORT'] ?? '4078', 10),
            nodeEnv,
        },
        db: {
            url: process.env['DATABASE_URL'],
            poolMax: parseInt(process.env['DB_POOL_MAX'] ?? '10', 10),
            poolMin: parseInt(process.env['DB_POOL_MIN'] ?? '2', 10),
        },
        cache: {
            maxSize: parseInt(process.env['MAX_CACHE_SIZE'] ?? '10000', 10),
        },
        bfs: {
            maxDepth: parseInt(process.env['MAX_BFS_DEPTH'] ?? '20', 10),
            maxNodes: parseInt(process.env['MAX_BFS_NODES'] ?? '1000', 10),
        },
        security: {
            apiKeySalt: apiKeySalt ?? 'dev_default_salt_not_for_production_use',
        },
        rateLimit: {
            maxRequests: parseInt(process.env['RATE_LIMIT_MAX'] ?? '100', 10),
            windowMs: parseInt(process.env['RATE_LIMIT_WINDOW_MS'] ?? '10000', 10),
        },
        admin: {
            apiKeyHash: adminKeyHash,
        },
    })

    if (!result.success) {
        console.error('❌ Invalid Rune config — fix these before starting:\n', result.error.format())
        process.exit(1)
    }

    return result.data
}

export const config = loadConfig()

