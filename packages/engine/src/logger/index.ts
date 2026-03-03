/**
 * Pino logger singleton.
 * All structured logging goes through this — no console.log anywhere in src/.
 *
 * In development: pretty-printed colorized output.
 * In production:  raw JSON for log aggregators (Datadog, Loki, etc.)
 */
import pino from 'pino'
import { config } from '../config/index.js'

const isDev = config.server.nodeEnv === 'development'

// Build options without undefined fields — required by exactOptionalPropertyTypes
const pinoOptions: pino.LoggerOptions = {
    level: config.server.nodeEnv === 'production' ? 'info' : 'debug',
    base: { service: 'rune-engine' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(isDev && {
        transport: {
            target: 'pino-pretty',
            options: { colorize: true, singleLine: false },
        },
    }),
}

export const logger = pino(pinoOptions)

/**
 * Create a child logger scoped to a specific request.
 * Use this inside route handlers to correlate log entries by requestId.
 *
 * @param requestId - Unique ID for the current request
 */
export function createRequestLogger(requestId: string): pino.Logger {
    return logger.child({ requestId })
}
