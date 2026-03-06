/**
 * Postgres circuit breaker — prevents cascading failures.
 *
 * STATES:
 *   CLOSED  → normal operation, queries flow through
 *   OPEN    → DB is assumed down, queries fail-fast with an error (no connection attempt)
 *   HALF_OPEN → one probe query is allowed through to test if DB recovered
 *
 * TRANSITIONS:
 *   CLOSED  → OPEN      when `failureThreshold` consecutive failures hit
 *   OPEN    → HALF_OPEN after `resetTimeoutMs` elapsed
 *   HALF_OPEN → CLOSED  if probe query succeeds
 *   HALF_OPEN → OPEN    if probe query fails (restart the timeout)
 *
 * WHY: If Postgres is down, every can() call waits for the connection timeout (2s)
 * before failing. At 1000 req/sec, that's 1000 connections stuck for 2s each —
 * exhausting the pool and making the entire engine unresponsive.
 * With the circuit breaker, after 5 failures it opens and returns DENY instantly (<1ms).
 */
import { logger } from '../logger/index.js'

type State = 'closed' | 'open' | 'half_open'

class DbCircuitBreaker {
    private state: State = 'closed'
    private failures = 0
    private lastFailureTime = 0

    private readonly failureThreshold = 5
    private readonly resetTimeoutMs = 10_000  // 10 seconds before trying again

    /** Check if a query is allowed to proceed. */
    canRequest(): boolean {
        if (this.state === 'closed') return true

        if (this.state === 'open') {
            // Check if enough time has passed to try again
            if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
                this.state = 'half_open'
                logger.info('db_circuit_breaker_half_open')
                return true  // allow one probe query
            }
            return false  // still open, reject
        }

        // half_open — allow the probe query
        return true
    }

    /** Call on successful query. */
    onSuccess(): void {
        if (this.state !== 'closed') {
            logger.info({ previousState: this.state }, 'db_circuit_breaker_closed')
        }
        this.failures = 0
        this.state = 'closed'
    }

    /** Call on failed query. */
    onFailure(): void {
        this.failures++
        this.lastFailureTime = Date.now()

        if (this.state === 'half_open') {
            // Probe failed — go back to open
            this.state = 'open'
            logger.warn({ failures: this.failures }, 'db_circuit_breaker_reopened')
            return
        }

        if (this.failures >= this.failureThreshold) {
            this.state = 'open'
            logger.error({ failures: this.failures }, 'db_circuit_breaker_opened')
        }
    }

    /** Current state for metrics/debugging. */
    getState(): { state: State; failures: number } {
        return { state: this.state, failures: this.failures }
    }
}

export const dbCircuitBreaker = new DbCircuitBreaker()
