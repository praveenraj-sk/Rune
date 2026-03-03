/**
 * Postgres connection pool singleton.
 *
 * All DB access goes through the `query()` helper — never create pools elsewhere.
 * This ensures consistent connection reuse, logging, and error handling.
 */
import pg from 'pg'
import { config } from '../config/index.js'
import { logger } from '../logger/index.js'

const pool = new pg.Pool({
    connectionString: config.db.url,
    max: config.db.poolMax,
    min: config.db.poolMin,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
})

// Log pool-level errors — these are connection failures, not query errors
pool.on('error', (error: Error) => {
    logger.error({ error: error.message }, 'postgres_pool_error')
})

pool.on('connect', () => {
    logger.debug('postgres_new_connection')
})

pool.on('remove', () => {
    logger.debug('postgres_connection_removed')
})

/**
 * Execute a parameterized SQL query.
 * Always use this — never pool.query() directly in business logic.
 *
 * Logs query duration at debug level.
 * Logs and re-throws any error (caller decides how to handle).
 *
 * @param sql    - Parameterized SQL string
 * @param params - Positional parameters ($1, $2, ...)
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
    const start = performance.now()
    try {
        const result = await pool.query<T>(sql, params)
        const duration = Math.round(performance.now() - start)
        logger.debug(
            { sql: sql.slice(0, 80), duration_ms: duration, rows: result.rowCount },
            'db_query_ok'
        )
        return result
    } catch (error) {
        logger.error(
            { error: (error as Error).message, sql: sql.slice(0, 80) },
            'db_query_failed'
        )
        throw error
    }
}

/**
 * Get a raw client from the pool for transactions.
 * ⚠️ Always release the client in a `finally` block to avoid pool exhaustion.
 */
export async function getClient(): Promise<pg.PoolClient> {
    return pool.connect()
}

export { pool }
