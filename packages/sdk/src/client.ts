/**
 * Rune SDK — HTTP Client
 *
 * Zero dependencies — uses Node.js native fetch only.
 * Requires Node.js >= 18.
 */
import type { RuneConfig, CanResult, TupleInput, TupleResult, LogsResult, HealthResult } from './types.js'

export class RuneClient {
    constructor(private readonly config: RuneConfig) {
        if (!config.apiKey) throw new Error('[Rune] apiKey is required')
        if (!config.baseUrl) throw new Error('[Rune] baseUrl is required')
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

    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeout)

        try {
            const url = `${this.config.baseUrl.replace(/\/$/, '')}${path}`

            // Build init without undefined fields (exactOptionalPropertyTypes)
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
        sct?: { lvn: number }
    }): Promise<CanResult> {
        return this.request<CanResult>('POST', '/v1/can', params)
    }

    /** Add a relationship tuple */
    async allow(tuple: TupleInput): Promise<TupleResult> {
        return this.request<TupleResult>('POST', '/v1/tuples', tuple)
    }

    /** Remove a relationship tuple */
    async revoke(tuple: TupleInput): Promise<TupleResult> {
        return this.request<TupleResult>('DELETE', '/v1/tuples', tuple)
    }

    /** Get recent decision logs for this tenant */
    async logs(): Promise<LogsResult> {
        return this.request<LogsResult>('GET', '/v1/logs')
    }

    /** Check engine health */
    async health(): Promise<HealthResult> {
        const url = `${this.config.baseUrl.replace(/\/$/, '')}/v1/health`
        const res = await fetch(url)
        return res.json() as Promise<HealthResult>
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
