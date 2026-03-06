/**
 * Postgres connection pool singleton.
 *
 * All DB access goes through the `query()` helper — never create pools elsewhere.
 * This ensures consistent connection reuse, logging, and error handling.
 *
 * In-memory test mode:
 *   When `enableMemoryMode()` is called (or RUNE_TEST_MODE=memory),
 *   query() routes to the in-memory adapter instead of Postgres.
 *   This enables zero-dependency testing without a live database.
 */
import pg from 'pg'
import { config } from '../config/index.js'
import { logger } from '../logger/index.js'
import { dbCircuitBreaker } from './circuit-breaker.js'
import { isMemoryMode, memoryQuery } from './memory-adapter.js'

const pool = new pg.Pool({
    connectionString: config.db.url,
    max: config.db.poolMax,
    min: config.db.poolMin,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
    // Postgres-native statement timeout — kills any query that exceeds this server-side.
    // Prevents runaway BFS queries or slow aggregations from holding connections forever.
    // The Postgres backend receives a cancel signal and stops work immediately.
    statement_timeout: 5000, // 5 seconds
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
 * Timeout: enforced at the pool level via `statement_timeout: 5000ms`.
 * Any query exceeding 5s is killed server-side by Postgres.
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
    // In-memory test mode — skip Postgres entirely
    if (isMemoryMode()) {
        return memoryQuery<T>(sql, params)
    }

    // Circuit breaker: if DB is known to be down, fail fast (<1ms) instead of
    // waiting 2s for the connection timeout on every request
    if (!dbCircuitBreaker.canRequest()) {
        throw new Error('db_circuit_breaker_open')
    }

    const start = performance.now()
    try {
        const result = await pool.query<T>(sql, params)
        const duration = Math.round(performance.now() - start)
        dbCircuitBreaker.onSuccess()
        logger.debug(
            { sql: sql.slice(0, 80), duration_ms: duration, rows: result.rowCount },
            'db_query_ok'
        )
        return result
    } catch (error) {
        const duration = Math.round(performance.now() - start)
        dbCircuitBreaker.onFailure()
        logger.error(
            { error: (error as Error).message, sql: sql.slice(0, 80), duration_ms: duration },
            'db_query_failed'
        )
        throw error
    }
}

/**
 * Get a raw client from the pool for transactions.
 * ⚠️ Always release the client in a `finally` block to avoid pool exhaustion.
 *
 * In memory mode, returns a mock client that routes queries through memoryQuery().
 */
export async function getClient(): Promise<pg.PoolClient> {
    if (isMemoryMode()) {
        // Return a mock PoolClient that delegates to memoryQuery
        return {
            query: async <T extends pg.QueryResultRow = pg.QueryResultRow>(
                sql: string,
                params?: unknown[],
            ) => memoryQuery<T>(sql, params ?? []),
            release: () => { /* no-op */ },
        } as unknown as pg.PoolClient
    }
    return pool.connect()
}

/**
 * Executes a callback within an LVN sequence-managed transaction.
 * Retrieves next sequence value, handles COMMIT/ROLLBACK, and releases the client.
 */
export async function withLvnTransaction(callback: (client: pg.PoolClient, lvn: number) => Promise<void>): Promise<number> {
    const client = await getClient()
    let lvn: number
    try {
        await client.query('BEGIN')
        const lvnResult = await client.query<{ nextval: string }>(`SELECT nextval('lvn_seq') as nextval`)
        const nextval = lvnResult.rows[0]?.nextval
        if (!nextval) throw new Error('lvn_seq returned no rows — possible DB fault')
        lvn = parseInt(nextval, 10)

        await callback(client, lvn)

        await client.query('COMMIT')
        return lvn
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { })
        throw err
    } finally {
        client.release()
    }
}

export { pool }
