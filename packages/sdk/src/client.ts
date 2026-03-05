/**
 * Rune SDK — HTTP Client
 *
 * Zero dependencies — uses Node.js native fetch only.
 * Requires Node.js >= 18.
 *
 * Built-in resilience:
 * - Retry with exponential backoff (configurable)
 * - Circuit breaker pattern (configurable)
 */
import type { RuneOptions, CacheStrategy, Permission, Grant, GrantResult, AuditLog, HealthStatus } from './types.js'
import { LocalCache } from './cache.js'

// ── Circuit Breaker State ────────────────────────────────────────────────────

type CircuitState = 'closed' | 'open' | 'half-open'

class CircuitBreaker {
    private state: CircuitState = 'closed'
    private failures = 0
    private lastFailureTime = 0

    constructor(
        private readonly threshold: number,
        private readonly resetTimeout: number,
    ) { }

    /** Check if request is allowed through */
    canRequest(): boolean {
        if (this.state === 'closed') return true
        if (this.state === 'open') {
            // Check if enough time has passed to try again
            if (Date.now() - this.lastFailureTime >= this.resetTimeout) {
                this.state = 'half-open'
                return true
            }
            return false
        }
        // half-open: allow one request to test
        return true
    }

    /** Record a successful request */
    onSuccess(): void {
        this.failures = 0
        this.state = 'closed'
    }

    /** Record a failed request */
    onFailure(): void {
        this.failures++
        this.lastFailureTime = Date.now()
        if (this.failures >= this.threshold) {
            this.state = 'open'
        }
    }

    getState(): CircuitState {
        return this.state
    }
}

// ── Client ───────────────────────────────────────────────────────────────────

export class RuneClient {
    private readonly circuit: CircuitBreaker | null
    private readonly localCache: LocalCache | null
    private readonly cacheStrategy: CacheStrategy
    private readonly retryAttempts: number
    private readonly retryBaseDelay: number
    private readonly retryMaxDelay: number

    constructor(private readonly config: RuneOptions) {
        if (!config.apiKey) throw new Error('[Rune] apiKey is required')
        if (!config.baseUrl) throw new Error('[Rune] baseUrl is required')

        // Circuit breaker setup
        if (config.circuitBreaker === false) {
            this.circuit = null
        } else {
            const cb = config.circuitBreaker ?? {}
            this.circuit = new CircuitBreaker(
                cb.threshold ?? 5,
                cb.resetTimeout ?? 30_000,
            )
        }

        // Retry setup
        if (config.retry === false) {
            this.retryAttempts = 0
            this.retryBaseDelay = 0
            this.retryMaxDelay = 0
        } else {
            const r = config.retry ?? {}
            this.retryAttempts = r.attempts ?? 2
            this.retryBaseDelay = r.baseDelay ?? 200
            this.retryMaxDelay = r.maxDelay ?? 2000
        }

        // Local cache setup (disabled by default)
        if (config.cache) {
            const cacheOpts: { maxSize?: number; ttl?: number } = {}
            if (config.cache.maxSize !== undefined) cacheOpts.maxSize = config.cache.maxSize
            if (config.cache.ttl !== undefined) cacheOpts.ttl = config.cache.ttl
            this.localCache = new LocalCache(cacheOpts)
            this.cacheStrategy = config.cache.strategy ?? 'allow_and_deny'
        } else {
            this.localCache = null
            this.cacheStrategy = 'none'
        }
    }

    private get headers(): Record<string, string> {
        return {
            'x-api-key': this.config.apiKey,
            'Content-Type': 'application/json',
        }
    }

    private get timeout(): number {
        return this.config.timeout ?? 5000
    }

    /** Sleep for a given number of ms */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    /** Calculate backoff delay with jitter */
    private getBackoffDelay(attempt: number): number {
        const delay = Math.min(
            this.retryBaseDelay * Math.pow(2, attempt),
            this.retryMaxDelay,
        )
        // Add ±25% jitter to avoid thundering herd
        const jitter = delay * 0.25 * (Math.random() * 2 - 1)
        return Math.round(delay + jitter)
    }

    /** Should this error be retried? (network errors & 5xx, not 4xx) */
    private isRetryable(error: unknown): boolean {
        if (error instanceof RuneError) {
            // Don't retry client errors (400, 401, 403, 404, 422)
            // Do retry server errors (500, 502, 503, 504)
            return error.statusCode >= 500
        }
        // Retry network errors, timeouts, etc.
        return true
    }

    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        // Circuit breaker check
        if (this.circuit && !this.circuit.canRequest()) {
            throw new RuneError(
                `Circuit breaker is open — engine at ${this.config.baseUrl} appears to be down. ` +
                `Will retry automatically in a few seconds.`,
                503,
            )
        }

        let lastError: unknown

        // Attempt 1 + retries
        for (let attempt = 0; attempt <= this.retryAttempts; attempt++) {
            try {
                const result = await this.singleRequest<T>(method, path, body)
                // Success — reset circuit breaker
                this.circuit?.onSuccess()
                return result
            } catch (error) {
                lastError = error

                // Don't retry non-retryable errors
                if (!this.isRetryable(error)) {
                    throw error
                }

                // Don't sleep after the last attempt
                if (attempt < this.retryAttempts) {
                    await this.sleep(this.getBackoffDelay(attempt))
                }
            }
        }

        // All attempts exhausted — record circuit breaker failure
        this.circuit?.onFailure()
        throw lastError
    }

    /** Single HTTP request (no retry logic) */
    private async singleRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeout)

        try {
            const url = `${this.config.baseUrl.replace(/\/$/, '')}${path}`

            const init: RequestInit = {
                method,
                headers: this.headers,
                signal: controller.signal,
            }
            if (body !== undefined) {
                init.body = JSON.stringify(body)
            }

            const res = await fetch(url, init)

            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
                throw new RuneError(err.error ?? res.statusText, res.status)
            }

            return res.json() as Promise<T>
        } catch (error) {
            if ((error as Error).name === 'AbortError') {
                throw new RuneError(`Request timed out after ${this.timeout}ms`, 408)
            }
            throw error
        } finally {
            clearTimeout(timer)
        }
    }

    /** Check if a subject can perform an action on an object */
    async check(params: {
        subject: string
        action: string
        object: string
        tenant?: string
        sct?: { lvn: number }
    }): Promise<Permission> {
        // Check local cache first — only if strategy allows reading cached decisions
        if (this.localCache && this.cacheStrategy !== 'none') {
            const key = LocalCache.buildKey(params.subject, params.action, params.object)
            const cached = this.localCache.get(key, params.sct?.lvn)
            if (cached) {
                // deny_only strategy: skip if this was a cached ALLOW (only DENY is allowed in cache)
                const isAllowHit = cached.decision === 'allow'
                if (!isAllowHit || this.cacheStrategy === 'allow_and_deny') {
                    return {
                        decision: cached.decision,
                        status: cached.status,
                        reason: cached.reason + ' (sdk-cache)',
                        trace: [],
                        suggested_fix: [],
                        cache_hit: true,
                        latency_ms: 0,
                        sct: { lvn: params.sct?.lvn ?? 0 },
                    } as Permission
                }
            }
        }

        const result = await this.request<Permission>('POST', '/v1/can', params)

        // Store in local cache based on strategy
        if (this.localCache && result.status !== 'NOT_FOUND') {
            const shouldCacheDeny = this.cacheStrategy === 'deny_only' || this.cacheStrategy === 'allow_and_deny'
            const shouldCacheAllow = this.cacheStrategy === 'allow_and_deny'
            const isDeny = result.status === 'DENY'
            const isAllow = result.status === 'ALLOW'

            if ((isDeny && shouldCacheDeny) || (isAllow && shouldCacheAllow)) {
                const key = LocalCache.buildKey(params.subject, params.action, params.object)
                this.localCache.set(
                    key,
                    { decision: result.decision, status: result.status, reason: result.reason },
                    result.sct?.lvn ?? 0,
                )
            }
        }

        return result
    }

    /** Add a relationship — grant someone access */
    async allow(grant: Grant): Promise<GrantResult> {
        const result = await this.request<GrantResult>('POST', '/v1/tuples', grant)
        // Invalidate local cache — permissions may have changed
        this.localCache?.clear()
        return result
    }

    /** Remove a relationship — revoke someone's access */
    async revoke(grant: Grant): Promise<GrantResult> {
        const result = await this.request<GrantResult>('DELETE', '/v1/tuples', grant)
        // Invalidate local cache — permissions may have changed
        this.localCache?.clear()
        return result
    }

    /** Get recent decision audit log for this tenant */
    async logs(): Promise<AuditLog> {
        return this.request<AuditLog>('GET', '/v1/logs')
    }

    /** Check engine health status */
    async health(): Promise<HealthStatus> {
        return this.singleRequest<HealthStatus>('GET', '/v1/health')
    }
}

/** Rune-specific error with HTTP status code */
export class RuneError extends Error {
    constructor(
        message: string,
        public readonly statusCode: number,
    ) {
        super(message)
        this.name = 'RuneError'
    }
}
