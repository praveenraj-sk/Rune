/**
 * ABAC Conditions unit tests — core package.
 *
 * Focuses on time_between UTC correctness to verify Fix 4.
 * All time values in ctx.time are explicit Date objects so tests
 * are deterministic regardless of the machine's local timezone.
 */
import { describe, test, expect } from 'vitest'
import { evaluateConditions, allConditionsPassed } from '../src/conditions.js'
import type { ConditionDef } from '../src/conditions.js'

// Helper: build a single-condition map for evaluateConditions
function makeConditions(when: Record<string, unknown>, apply_to: string[]): Record<string, ConditionDef> {
    return { test_cond: { when, apply_to } }
}

describe('time_between — UTC correctness', () => {
    const conditions = makeConditions({ time_between: ['09:00', '17:00'] }, ['edit'])

    test('08:30 UTC — BEFORE window — should DENY', () => {
        const ctx = { time: new Date('2024-01-15T08:30:00Z') }
        const results = evaluateConditions(conditions, 'edit', ctx)
        expect(results[0]?.passed).toBe(false)
        expect(results[0]?.reason).toContain('08:30 UTC')
        expect(results[0]?.reason).toContain('outside')
    })

    test('09:00 UTC — start of window — should ALLOW', () => {
        const ctx = { time: new Date('2024-01-15T09:00:00Z') }
        const results = evaluateConditions(conditions, 'edit', ctx)
        expect(results[0]?.passed).toBe(true)
        expect(results[0]?.reason).toContain('09:00 UTC')
    })

    test('13:00 UTC — middle of window — should ALLOW', () => {
        const ctx = { time: new Date('2024-01-15T13:00:00Z') }
        const results = evaluateConditions(conditions, 'edit', ctx)
        expect(results[0]?.passed).toBe(true)
    })

    test('17:00 UTC — end of window — should ALLOW', () => {
        const ctx = { time: new Date('2024-01-15T17:00:00Z') }
        const results = evaluateConditions(conditions, 'edit', ctx)
        expect(results[0]?.passed).toBe(true)
    })

    test('17:01 UTC — AFTER window — should DENY', () => {
        const ctx = { time: new Date('2024-01-15T17:01:00Z') }
        const results = evaluateConditions(conditions, 'edit', ctx)
        expect(results[0]?.passed).toBe(false)
        expect(results[0]?.reason).toContain('outside')
    })

    test('condition does not apply to non-matching actions', () => {
        const ctx = { time: new Date('2024-01-15T23:00:00Z') }
        // 'read' is not in apply_to — should return no results (pass through)
        const results = evaluateConditions(conditions, 'read', ctx)
        expect(results).toHaveLength(0)
        expect(allConditionsPassed(results)).toBe(true)
    })

    test('reason string always contains UTC label', () => {
        const ctx = { time: new Date('2024-01-15T10:30:00Z') }
        const results = evaluateConditions(conditions, 'edit', ctx)
        expect(results[0]?.reason).toContain('UTC')
    })
})
