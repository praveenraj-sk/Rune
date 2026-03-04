/**
 * Rune SDK — HTTP Client
 *
 * Zero dependencies — uses Node.js native fetch only.
 * Requires Node.js >= 18.
 */
import type { RuneOptions, Permission, Grant, GrantResult, AuditLog, HealthStatus } from './types.js'

export class RuneClient {
    constructor(private readonly config: RuneOptions) {
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
    }): Promise<Permission> {
        return this.request<Permission>('POST', '/v1/can', params)
    }

    /** Add a relationship — grant someone access */
    async allow(grant: Grant): Promise<GrantResult> {
        return this.request<GrantResult>('POST', '/v1/tuples', grant)
    }

    /** Remove a relationship — revoke someone's access */
    async revoke(grant: Grant): Promise<GrantResult> {
        return this.request<GrantResult>('DELETE', '/v1/tuples', grant)
    }

    /** Get recent decision audit log for this tenant */
    async logs(): Promise<AuditLog> {
        return this.request<AuditLog>('GET', '/v1/logs')
    }

    /** Check engine health status */
    async health(): Promise<HealthStatus> {
        const url = `${this.config.baseUrl.replace(/\/$/, '')}/v1/health`
        const res = await fetch(url)
        return res.json() as Promise<HealthStatus>
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
