/**
 * HybridStore — merges Rune's internal tuples with live database data.
 *
 * This is the magic of Zero-Sync:
 * - BFS reads from BOTH the Rune tuple store AND the app's database
 * - No data duplication needed
 * - Rune tuples for explicit grants, DB for existing relationships
 *
 * @example
 * ```ts
 * const hybrid = new HybridStore(memoryStore, [sqlDataSource])
 * // BFS will find edges from both sources
 * ```
 */
import type { Tuple, TupleStore } from './store/types.js'
import type { DataSource, ExternalTuple } from './datasource/types.js'

export class HybridStore implements TupleStore {
    private readonly primary: TupleStore
    private readonly dataSources: DataSource[]

    constructor(primary: TupleStore, dataSources: DataSource[]) {
        this.primary = primary
        this.dataSources = dataSources
    }

    async add(tuple: Tuple): Promise<void> {
        return this.primary.add(tuple)
    }

    async remove(tuple: Tuple): Promise<void> {
        return this.primary.remove(tuple)
    }

    async objectExists(tenantId: string, object: string): Promise<boolean> {
        // Check primary store first
        if (await this.primary.objectExists(tenantId, object)) return true

        // Then check datasources
        for (const ds of this.dataSources) {
            if (await ds.objectExists(object)) return true
        }

        return false
    }

    async getEdges(tenantId: string, subjects: string[]): Promise<Tuple[]> {
        // Get edges from primary store
        const primaryEdges = await this.primary.getEdges(tenantId, subjects)

        // Get edges from all datasources in parallel
        const externalPromises = this.dataSources.map(ds => ds.getEdgesForSubjects(subjects))
        const externalResults = await Promise.all(externalPromises)

        // Convert external tuples to Rune tuples
        const externalEdges: Tuple[] = externalResults
            .flat()
            .map((ext: ExternalTuple) => ({
                subject: ext.subject,
                relation: ext.relation,
                object: ext.object,
                tenantId,
            }))

        return [...primaryEdges, ...externalEdges]
    }

    async list(tenantId: string, options?: { limit?: number; offset?: number; search?: string }) {
        // List only shows primary store tuples (external data stays in app DB)
        return this.primary.list(tenantId, options)
    }
}
