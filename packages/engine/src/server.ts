/**
 * Rune Engine — Fastify server entry point.
 *
 * Registers all routes under /v1 prefix.
 * Global error handler never exposes stack traces or internal errors.
 */

// Must be the very first thing — loads .env before any config is read.
// override:true ensures .env wins over shell env vars (e.g. system DATABASE_URL).
// process.cwd() = packages/engine/ when run via pnpm dev → ../../.env = project root
import { config as loadEnv } from 'dotenv'
import { resolve } from 'path'
loadEnv({ path: resolve(process.cwd(), '../../.env'), override: true })

import Fastify from 'fastify'
import { config } from './config/index.js'
import { logger } from './logger/index.js'
import { canRoute } from './routes/can.route.js'
import { tuplesRoute } from './routes/tuples.route.js'
import { healthRoute } from './routes/health.route.js'
import { errorHandler } from './middleware/error-handler.js'

const fastify = Fastify({
    logger: false,  // we use our own pino logger
})

fastify.setErrorHandler(errorHandler)

// Register all routes under /v1
fastify.register(canRoute, { prefix: '/v1' })
fastify.register(tuplesRoute, { prefix: '/v1' })
fastify.register(healthRoute, { prefix: '/v1' })

// Start server
const start = async () => {
    try {
        const address = await fastify.listen({ port: config.server.port, host: '0.0.0.0' })
        logger.info({ address, env: config.server.nodeEnv }, 'rune_engine_started')
    } catch (err) {
        logger.error({ err }, 'rune_engine_start_failed')
        process.exit(1)
    }
}

start()
