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
import { config } from './config/index.js'
import { logger } from './logger/index.js'
import { canRoute } from './routes/can.route.js'
import { tuplesRoute } from './routes/tuples.route.js'
import { healthRoute } from './routes/health.route.js'
import { setupRoute } from './routes/setup.route.js'
import { statsRoute } from './routes/stats.route.js'
import { adminRoute } from './routes/admin.route.js'
import { errorHandler } from './middleware/error-handler.js'
import { loadPolicy } from './policy/config.js'

const fastify = Fastify({
    logger: false,  // we use our own pino logger
})

fastify.setErrorHandler(errorHandler)

// Register all routes under /v1
fastify.register(canRoute, { prefix: '/v1' })
fastify.register(tuplesRoute, { prefix: '/v1' })
fastify.register(healthRoute, { prefix: '/v1' })
fastify.register(setupRoute, { prefix: '/v1' })
fastify.register(statsRoute, { prefix: '/v1' })
fastify.register(adminRoute, { prefix: '/v1' })

// Start server
const start = async () => {
    try {
        // Load authorization policy from rune.config.yml (or defaults)
        loadPolicy()

        const address = await fastify.listen({ port: config.server.port, host: '0.0.0.0' })
        logger.info({ address, env: config.server.nodeEnv }, 'rune_engine_started')
    } catch (err) {
        logger.error({ err }, 'rune_engine_start_failed')
        process.exit(1)
    }
}

start()
