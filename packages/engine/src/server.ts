/**
 * Rune Engine — Fastify server entry point.
 *
 * Registers all routes under /v1 prefix.
 * Global error handler never exposes stack traces or internal errors.
 */

// MUST be first — loads .env before config/index.ts evaluates process.env.
// See env-setup.ts for why a separate file is required (ESM import hoisting).
import './env-setup.js'

import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import path from 'path'
import { fileURLToPath } from 'url'
import { config } from './config/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
import { logger } from './logger/index.js'
import { canRoute } from './routes/can.route.js'
import { tuplesRoute } from './routes/tuples.route.js'
import { healthRoute } from './routes/health.route.js'
import { setupRoute } from './routes/setup.route.js'
import { statsRoute } from './routes/stats.route.js'
import { adminRoute } from './routes/admin.route.js'
import { graphRoute } from './routes/graph.route.js'
import { indexHealthRoute } from './routes/index-health.route.js'
import { indexRebuildRoute } from './routes/index-rebuild.route.js'
import { metricsRoute } from './routes/metrics.route.js'
import { batchRoute } from './routes/batch.route.js'
import { errorHandler } from './middleware/error-handler.js'
import { registerRequestId } from './middleware/request-id.js'
import { loadPolicy, stopWatchingPolicy } from './policy/config.js'
import { refreshLvnFromDb } from './engine/lvn.js'
import { pool } from './db/client.js'

const fastify = Fastify({
    logger: false,  // we use our own pino logger
})

fastify.setErrorHandler(errorHandler)

// Request ID correlation — every request gets a unique ID for log tracing
registerRequestId(fastify)

// Register all routes under /v1
fastify.register(canRoute, { prefix: '/v1' })
fastify.register(tuplesRoute, { prefix: '/v1' })
fastify.register(healthRoute, { prefix: '/v1' })
fastify.register(setupRoute, { prefix: '/v1' })
fastify.register(statsRoute, { prefix: '/v1' })
fastify.register(adminRoute, { prefix: '/v1' })
fastify.register(graphRoute, { prefix: '/v1' })
fastify.register(indexHealthRoute, { prefix: '/v1' })
fastify.register(indexRebuildRoute, { prefix: '/v1' })
fastify.register(metricsRoute, { prefix: '/v1' })
fastify.register(batchRoute, { prefix: '/v1' })

// Serve static dashboard
fastify.register(fastifyStatic, {
    root: path.join(__dirname, 'dashboard'),
    prefix: '/dashboard/',
})

// Redirect /dashboard to /dashboard/index.html
fastify.get('/dashboard', (req, reply) => {
    reply.redirect('/dashboard/')
})


// ── Graceful Shutdown ──────────────────────────────────────────────────────
// On SIGTERM/SIGINT (Render, k8s, docker stop, Ctrl+C):
// 1. Stop accepting new connections
// 2. Wait for in-flight requests to finish (up to 30s)
// 3. Close the Postgres connection pool
// 4. Exit cleanly
//
// Without this: process.kill() drops requests mid-flight, causes 502s.

const SHUTDOWN_TIMEOUT_MS = 30_000

async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'graceful_shutdown_started')

    // Set a hard deadline — if something hangs, force exit
    const forceExit = setTimeout(() => {
        logger.error({ signal }, 'graceful_shutdown_timeout — forcing exit')
        process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    forceExit.unref()

    try {
        // Stop watching config file for changes
        stopWatchingPolicy()

        // fastify.close() stops accepting new requests and waits for in-flight ones
        await fastify.close()
        logger.info({ signal }, 'fastify_closed')

        // Close all idle Postgres connections
        await pool.end()
        logger.info({ signal }, 'postgres_pool_closed')

        logger.info({ signal }, 'graceful_shutdown_complete')
        process.exit(0)
    } catch (err) {
        logger.error({ err, signal }, 'graceful_shutdown_error')
        process.exit(1)
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// Start server
const start = async () => {
    try {
        // Load authorization policy from rune.config.yml (or defaults)
        loadPolicy()

        // Priority 1 fix: sync LVN from DB once on startup so the in-memory
        // value is correct after a server restart (Render deploys, etc.)
        await refreshLvnFromDb()

        const address = await fastify.listen({ port: config.server.port, host: '0.0.0.0' })
        logger.info({ address, env: config.server.nodeEnv }, 'rune_engine_started')
    } catch (err) {
        logger.error({ err }, 'rune_engine_start_failed')
        process.exit(1)
    }
}

start()
