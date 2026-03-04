/**
 * In-memory TupleStore — zero dependencies, runs anywhere.
 *
 * Perfect for:
 * - Local development (no DB needed)
 * - Unit testing
 * - Prototyping
 * - Small apps that don't need persistence
 */
import type { Tuple, TupleStore } from './types.js'

export class MemoryStore implements TupleStore {
    private tuples: Tuple[] = []

    async add(tuple: Tuple): Promise<void> {
        // Deduplicate
        const exists = this.tuples.some(
            t => t.tenantId === tuple.tenantId &&
                t.subject === tuple.subject &&
                t.relation === tuple.relation &&
                t.object === tuple.object
        )
        if (!exists) {
            this.tuples.push({ ...tuple })
        }
    }

    async remove(tuple: Tuple): Promise<void> {
        this.tuples = this.tuples.filter(
            t => !(t.tenantId === tuple.tenantId &&
                t.subject === tuple.subject &&
                t.relation === tuple.relation &&
                t.object === tuple.object)
        )
    }

    async objectExists(tenantId: string, object: string): Promise<boolean> {
        return this.tuples.some(t => t.tenantId === tenantId && t.object === object)
    }

    async getEdges(tenantId: string, subjects: string[]): Promise<Tuple[]> {
        return this.tuples.filter(
            t => t.tenantId === tenantId && subjects.includes(t.subject)
        )
    }

    async list(tenantId: string, options?: { limit?: number; offset?: number; search?: string }): Promise<{ tuples: Tuple[]; total: number }> {
        let filtered = this.tuples.filter(t => t.tenantId === tenantId)

        if (options?.search) {
            const q = options.search.toLowerCase()
            filtered = filtered.filter(
                t => t.subject.toLowerCase().includes(q) ||
                    t.relation.toLowerCase().includes(q) ||
                    t.object.toLowerCase().includes(q)
            )
        }

        const total = filtered.length
        const offset = options?.offset ?? 0
        const limit = options?.limit ?? 50
        const tuples = filtered.slice(offset, offset + limit)

        return { tuples, total }
    }

    /** Clear all tuples (useful for testing) */
    clear(): void {
        this.tuples = []
    }

    /** Get total count */
    get size(): number {
        return this.tuples.length
    }
}
