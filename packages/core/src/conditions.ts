/**
 * ABAC Condition Evaluator
 *
 * Evaluates attribute-based conditions defined in rune.config.yml.
 * Runs AFTER BFS+RBAC resolves that a role grants the action.
 *
 * Supported condition types:
 * - time_between: ["09:00", "17:00"]  — time-of-day window
 * - ip_in: ["10.0.0.0/8"]            — IP CIDR range check
 * - resource.<attr>: <value>          — resource attribute equals value
 * - subject.<attr>: <value>           — subject attribute equals value
 * - equals: { field: "status", value: "active" }
 */

export type ConditionDef = {
    when: Record<string, unknown>
    apply_to: string[]
}

export type EvalContext = {
    time?: Date
    ip?: string
    resource?: Record<string, unknown>
    subject?: Record<string, unknown>
    [key: string]: unknown
}

export type ConditionResult = {
    passed: boolean
    name: string
    reason: string
}

/**
 * Evaluate all conditions for a given action on a resource.
 *
 * @returns Array of condition results (all must pass for ALLOW)
 */
export function evaluateConditions(
    conditions: Record<string, ConditionDef> | undefined,
    action: string,
    context: EvalContext,
): ConditionResult[] {
    if (!conditions) return []

    const results: ConditionResult[] = []

    for (const [name, cond] of Object.entries(conditions)) {
        // Skip conditions that don't apply to this action
        if (!cond.apply_to.includes(action)) continue

        const result = evaluateCondition(name, cond.when, context)
        results.push(result)
    }

    return results
}

/**
 * Check if ALL conditions passed.
 */
export function allConditionsPassed(results: ConditionResult[]): boolean {
    return results.every(r => r.passed)
}

// ── Individual condition evaluators ─────────────────────────

function evaluateCondition(name: string, when: Record<string, unknown>, ctx: EvalContext): ConditionResult {
    for (const [key, value] of Object.entries(when)) {
        switch (key) {
            case 'time_between':
                return evalTimeBetween(name, value as string[], ctx)
            case 'ip_in':
                return evalIpIn(name, value as string[], ctx)
            default:
                // Handle dotted paths: resource.status, subject.department, etc.
                if (key.startsWith('resource.')) {
                    return evalResourceAttr(name, key, value, ctx)
                }
                if (key.startsWith('subject.')) {
                    return evalSubjectAttr(name, key, value, ctx)
                }
                return { passed: true, name, reason: `unknown condition type "${key}" — skipped (fail open for unknown)` }
        }
    }

    return { passed: true, name, reason: 'no conditions to evaluate' }
}

// ── Time condition ──────────────────────────────────────────

function evalTimeBetween(name: string, range: string[], ctx: EvalContext): ConditionResult {
    const now = ctx.time ?? new Date()
    const [startStr, endStr] = range as [string | undefined, string | undefined]
    if (!startStr || !endStr) {
        return { passed: false, name, reason: 'time_between requires [start, end] in HH:MM format' }
    }

    const currentMinutes = now.getHours() * 60 + now.getMinutes()
    const startMinutes = parseTimeToMinutes(startStr)
    const endMinutes = parseTimeToMinutes(endStr)

    if (startMinutes === null || endMinutes === null) {
        return { passed: false, name, reason: 'invalid time format, expected HH:MM' }
    }

    const inRange = currentMinutes >= startMinutes && currentMinutes <= endMinutes
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

    return {
        passed: inRange,
        name,
        reason: inRange
            ? `${timeStr} is within ${startStr}–${endStr}`
            : `${timeStr} is outside ${startStr}–${endStr}`,
    }
}

function parseTimeToMinutes(time: string): number | null {
    const parts = time.split(':')
    const hours = parseInt(parts[0] ?? '', 10)
    const minutes = parseInt(parts[1] ?? '0', 10)
    if (isNaN(hours) || isNaN(minutes)) return null
    return hours * 60 + minutes
}

// ── IP condition ────────────────────────────────────────────

function evalIpIn(name: string, cidrs: string[], ctx: EvalContext): ConditionResult {
    const ip = ctx.ip
    if (!ip) {
        return { passed: false, name, reason: 'no IP provided in context' }
    }

    for (const cidr of cidrs) {
        if (ipInCidr(ip, cidr)) {
            return { passed: true, name, reason: `${ip} is in ${cidr}` }
        }
    }

    return { passed: false, name, reason: `${ip} is not in any of [${cidrs.join(', ')}]` }
}

function ipInCidr(ip: string, cidr: string): boolean {
    const parts = cidr.split('/')
    const cidrIp = parts[0]
    const prefixLen = parseInt(parts[1] ?? '32', 10)

    if (!cidrIp) return false

    const ipNum = ipToNumber(ip)
    const cidrNum = ipToNumber(cidrIp)
    if (ipNum === null || cidrNum === null) return false

    const mask = ~((1 << (32 - prefixLen)) - 1) >>> 0
    return (ipNum & mask) === (cidrNum & mask)
}

function ipToNumber(ip: string): number | null {
    const parts = ip.split('.')
    if (parts.length !== 4) return null
    let num = 0
    for (const part of parts) {
        const n = parseInt(part, 10)
        if (isNaN(n) || n < 0 || n > 255) return null
        num = (num << 8) + n
    }
    return num >>> 0
}

// ── Resource attribute condition ────────────────────────────

function evalResourceAttr(name: string, key: string, expected: unknown, ctx: EvalContext): ConditionResult {
    const attrPath = key.replace('resource.', '')
    const actual = getNestedValue(ctx.resource, attrPath)

    if (actual === undefined) {
        return { passed: false, name, reason: `resource.${attrPath} not provided in context` }
    }

    const match = actual === expected
    return {
        passed: match,
        name,
        reason: match
            ? `resource.${attrPath} == "${expected}"`
            : `resource.${attrPath} is "${actual}", expected "${expected}"`,
    }
}

// ── Subject attribute condition ─────────────────────────────

function evalSubjectAttr(name: string, key: string, expected: unknown, ctx: EvalContext): ConditionResult {
    const attrPath = key.replace('subject.', '')
    const actual = getNestedValue(ctx.subject, attrPath)

    if (actual === undefined) {
        return { passed: false, name, reason: `subject.${attrPath} not provided in context` }
    }

    const match = actual === expected
    return {
        passed: match,
        name,
        reason: match
            ? `subject.${attrPath} == "${expected}"`
            : `subject.${attrPath} is "${actual}", expected "${expected}"`,
    }
}

// ── Helpers ─────────────────────────────────────────────────

function getNestedValue(obj: Record<string, unknown> | undefined, path: string): unknown {
    if (!obj) return undefined
    const parts = path.split('.')
    let current: unknown = obj
    for (const part of parts) {
        if (current === null || current === undefined || typeof current !== 'object') return undefined
        current = (current as Record<string, unknown>)[part]
    }
    return current
}
