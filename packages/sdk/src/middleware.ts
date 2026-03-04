/**
 * Express / Fastify middleware for one-line route protection.
 *
 * @example
 * ```ts
 * import { Rune } from '@runeauth/sdk'
 *
 * const rune = new Rune({ apiKey: '...', baseUrl: '...' })
 *
 * // Protect a route with one line:
 * app.get('/docs/:id', rune.protect('read', 'document:{{params.id}}'), handler)
 *
 * // Template variables:
 * //   {{params.id}}     → req.params.id
 * //   {{user.id}}       → req.user.id
 * //   {{body.projectId}} → req.body.projectId
 * //   {{query.org}}     → req.query.org
 * ```
 */
import type { RuneClient } from './client.js'

/**
 * MiddlewareConfig — options for rune.protect()
 */
export type MiddlewareConfig = {
    /** How to extract the subject from the request. Default: req.user.id */
    subjectFrom?: string | ((req: MiddlewareRequest) => string)
    /** Subject prefix. Default: 'user:' */
    subjectPrefix?: string
    /** Custom error handler. Default: sends 403 JSON */
    onDeny?: (req: MiddlewareRequest, res: MiddlewareResponse, reason: string) => void
}

// Minimal request/response types — works with Express, Fastify, Koa, etc.
export type MiddlewareRequest = {
    params?: Record<string, string>
    query?: Record<string, string>
    body?: Record<string, unknown>
    user?: Record<string, unknown>
    headers?: Record<string, string | string[] | undefined>
    [key: string]: unknown
}

export type MiddlewareResponse = {
    status?: (code: number) => MiddlewareResponse
    json?: (body: unknown) => void
    statusCode?: number
    send?: (body: unknown) => void
    [key: string]: unknown
}

export type MiddlewareNext = (err?: unknown) => void

export type MiddlewareFn = (req: MiddlewareRequest, res: MiddlewareResponse, next: MiddlewareNext) => void

/**
 * Create an Express/Fastify middleware that checks authorization.
 *
 * @param client - RuneClient instance
 * @param action - Action to check (e.g. 'read', 'edit', 'delete')
 * @param objectTemplate - Object template with {{}} placeholders (e.g. 'document:{{params.id}}')
 * @param config - Optional middleware configuration
 */
export function createProtectMiddleware(
    client: RuneClient,
    action: string,
    objectTemplate: string,
    config?: MiddlewareConfig,
): MiddlewareFn {
    const subjectPrefix = config?.subjectPrefix ?? 'user:'

    return async (req: MiddlewareRequest, res: MiddlewareResponse, next: MiddlewareNext) => {
        try {
            // 1. Extract subject
            const subject = extractSubject(req, subjectPrefix, config?.subjectFrom)
            if (!subject) {
                sendDeny(req, res, 'Could not extract user identity from request', config?.onDeny)
                return
            }

            // 2. Resolve object template
            const object = resolveTemplate(objectTemplate, req)
            if (!object) {
                sendDeny(req, res, `Could not resolve object template: ${objectTemplate}`, config?.onDeny)
                return
            }

            // 3. Check permission
            const result = await client.check({ subject, action, object })

            if (result.status === 'ALLOW') {
                // Attach permission to request for downstream use
                (req as Record<string, unknown>).runePermission = result
                next()
            } else {
                sendDeny(req, res, result.reason ?? `${subject} cannot ${action} on ${object}`, config?.onDeny)
            }
        } catch (error) {
            // Fail closed — deny on error
            sendDeny(req, res, 'Authorization check failed', config?.onDeny)
        }
    }
}

// ── Template Resolution ─────────────────────────────────────

/**
 * Resolve a template string with request data.
 * e.g. 'document:{{params.id}}' + req.params.id='123' → 'document:123'
 */
function resolveTemplate(template: string, req: MiddlewareRequest): string | null {
    const resolved = template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
        const value = getNestedValue(req, path.trim())
        return value !== undefined && value !== null ? String(value) : ''
    })

    // If any placeholder resolved to empty, the template is invalid
    if (resolved.includes('::') || resolved.endsWith(':') || resolved === template.replace(/\{\{[^}]+\}\}/g, '')) {
        // Check if all placeholders were resolved
        const hasUnresolved = template.includes('{{') && resolved === template.replace(/\{\{[^}]+\}\}/g, '')
        if (hasUnresolved) return null
    }

    return resolved || null
}

/**
 * Get a nested value from an object using dot notation.
 * e.g. getNestedValue(req, 'params.id') → req.params.id
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.')
    let current: unknown = obj
    for (const part of parts) {
        if (current === null || current === undefined || typeof current !== 'object') return undefined
        current = (current as Record<string, unknown>)[part]
    }
    return current
}

// ── Subject Extraction ──────────────────────────────────────

function extractSubject(
    req: MiddlewareRequest,
    prefix: string,
    subjectFrom?: string | ((req: MiddlewareRequest) => string),
): string | null {
    // Custom function
    if (typeof subjectFrom === 'function') {
        const result = subjectFrom(req)
        return result || null
    }

    // Custom path
    if (typeof subjectFrom === 'string') {
        const value = getNestedValue(req as Record<string, unknown>, subjectFrom)
        return value ? `${prefix}${value}` : null
    }

    // Default: try common locations
    const user = req.user as Record<string, unknown> | undefined
    const candidates = [
        user?.['id'],
        user?.['sub'],
        user?.['userId'],
        (req as Record<string, unknown>)['userId'],
    ] as unknown[]

    for (const candidate of candidates) {
        if (candidate !== undefined && candidate !== null && candidate !== '') {
            return `${prefix}${candidate}`
        }
    }

    return null
}

// ── Error Response ──────────────────────────────────────────

function sendDeny(
    req: MiddlewareRequest,
    res: MiddlewareResponse,
    reason: string,
    customHandler?: (req: MiddlewareRequest, res: MiddlewareResponse, reason: string) => void,
): void {
    if (customHandler) {
        customHandler(req, res, reason)
        return
    }

    // Express-style response
    if (typeof res.status === 'function' && typeof res.json === 'function') {
        const r = res.status(403)
        if (r && typeof r.json === 'function') r.json({ error: 'forbidden', reason })
        return
    }

    // Fastify-style response
    if (res.statusCode !== undefined && typeof res.send === 'function') {
        res.statusCode = 403
        res.send({ error: 'forbidden', reason })
    }
}
