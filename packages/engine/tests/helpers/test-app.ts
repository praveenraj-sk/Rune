/**
 * Creates a pre-configured Fastify test app with all routes and error handler.
 * Use this in all integration test files to ensure consistency with production.
 */
import Fastify from 'fastify'
import { canRoute } from '../../src/routes/can.route.js'
import { tuplesRoute } from '../../src/routes/tuples.route.js'
import { healthRoute } from '../../src/routes/health.route.js'
import { accessibleRoute } from '../../src/routes/accessible.route.js'
import { errorHandler } from '../../src/middleware/error-handler.js'

export function createTestApp() {
    const app = Fastify()
    app.setErrorHandler(errorHandler)
    app.register(canRoute, { prefix: '/v1' })
    app.register(tuplesRoute, { prefix: '/v1' })
    app.register(healthRoute, { prefix: '/v1' })
    app.register(accessibleRoute, { prefix: '/v1' })
    return app
}
