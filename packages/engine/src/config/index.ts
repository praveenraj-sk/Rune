/**
 * Central config module — ALL environment variables are read here.
 * No other file may read process.env directly.
 *
 * Validates config at startup using zod.
 * If any required var is missing → process.exit(1)
 * (zod is allowed in the engine package; zero-dep rule applies to SDK only)
 */
import { z } from 'zod'

const configSchema = z.object({
    server: z.object({
        port: z.number().min(1).max(65535).default(3001),
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
        maxDepth: z.number().default(20),
        maxNodes: z.number().default(1000),
    }),
    security: z.object({
        apiKeySalt: z.string().min(32, 'API_KEY_SALT must be at least 32 characters'),
    }),
})

export type Config = z.infer<typeof configSchema>

function loadConfig(): Config {
    const result = configSchema.safeParse({
        server: {
            port: parseInt(process.env['PORT'] ?? '3001', 10),
            nodeEnv: process.env['NODE_ENV'] ?? 'development',
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
            // In dev/test, allow a default salt so the server can start without .env
            apiKeySalt: process.env['API_KEY_SALT'] ?? 'dev_default_salt_not_for_production_use',
        },
    })

    if (!result.success) {
        // Use console.error here only — logger isn't initialized yet
        console.error('❌ Invalid Rune config — fix these before starting:\n', result.error.format())
        process.exit(1)
    }

    return result.data
}

export const config = loadConfig()
