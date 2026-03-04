/**
 * TupleStore interface — pluggable storage backend for the BFS engine.
 *
 * Implementations:
 * - MemoryStore: in-memory, zero dependencies, perfect for dev/testing
 * - PostgresStore: production-grade, persistent storage
 */

export type Tuple = {
    subject: string
    relation: string
    object: string
    tenantId: string
}

export interface TupleStore {
    /** Add a tuple (relationship) */
    add(tuple: Tuple): Promise<void>
    /** Remove a tuple */
    remove(tuple: Tuple): Promise<void>
    /** Check if object exists in the store */
    objectExists(tenantId: string, object: string): Promise<boolean>
    /** Get all outgoing edges from a set of subjects */
    getEdges(tenantId: string, subjects: string[]): Promise<Tuple[]>
    /** List tuples with optional filtering */
    list(tenantId: string, options?: { limit?: number; offset?: number; search?: string }): Promise<{ tuples: Tuple[]; total: number }>
}
