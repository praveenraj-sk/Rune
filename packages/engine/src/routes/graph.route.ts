/**
 * GET /v1/graph — Return the relationship graph for the tenant.
 *
 * Returns nodes and edges derived from the tuples table.
 * Supports optional ?search=user:arjun to subgraph from a node.
 *
 * Response: { nodes: [{id, type}], edges: [{source, relation, target}] }
 * Protected by authMiddleware (any valid API key).
 */
import type { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { rateLimitMiddleware } from '../middleware/rate-limit.js'
import { query } from '../db/client.js'
import { logger } from '../logger/index.js'

type TupleRow = {
    subject: string
    relation: string
    object: string
}

function extractNodeType(id: string): string {
    const colon = id.indexOf(':')
    return colon > 0 ? id.substring(0, colon) : 'unknown'
}

export async function graphRoute(fastify: FastifyInstance): Promise<void> {
    fastify.get<{
        Querystring: { search?: string; limit?: string }
    }>('/graph', {
        preHandler: [authMiddleware, rateLimitMiddleware],
    }, async (request, reply) => {
        const tenantId = request.tenantId
        const search = request.query.search?.trim()
        const limit = Math.min(500, parseInt(request.query.limit ?? '200', 10))

        try {
            let rows: TupleRow[]

            if (search) {
                // Subgraph: BFS from the search node (up to 3 hops)
                // Step 1: direct edges from search node
                const r1 = await query<TupleRow>(
                    `SELECT subject, relation, object FROM tuples
                     WHERE tenant_id = $1
                       AND (subject = $2 OR object = $2)
                     LIMIT $3`,
                    [tenantId, search, limit],
                )

                // Step 2: one hop out — neighbors of the search node
                const neighbors = new Set<string>()
                for (const row of r1.rows) {
                    neighbors.add(row.subject)
                    neighbors.add(row.object)
                }
                neighbors.delete(search)

                let r2rows: TupleRow[] = []
                if (neighbors.size > 0) {
                    const neighborList = [...neighbors]
                    const placeholders = neighborList.map((_, i) => `$${i + 3}`).join(', ')
                    const r2 = await query<TupleRow>(
                        `SELECT subject, relation, object FROM tuples
                         WHERE tenant_id = $1
                           AND (subject IN (${placeholders}) OR object IN (${placeholders}))
                         LIMIT $2`,
                        [tenantId, limit, ...neighborList],
                    )
                    r2rows = r2.rows
                }

                // Merge and deduplicate
                const seen = new Set<string>()
                rows = []
                for (const row of [...r1.rows, ...r2rows]) {
                    const key = `${row.subject}|${row.relation}|${row.object}`
                    if (!seen.has(key)) {
                        seen.add(key)
                        rows.push(row)
                    }
                }
            } else {
                // Full tenant graph (capped at limit)
                const result = await query<TupleRow>(
                    `SELECT subject, relation, object FROM tuples
                     WHERE tenant_id = $1
                     ORDER BY subject, object
                     LIMIT $2`,
                    [tenantId, limit],
                )
                rows = result.rows
            }

            // Build nodes and edges
            const nodeMap = new Map<string, { id: string; type: string }>()
            const edges: { source: string; relation: string; target: string }[] = []

            for (const row of rows) {
                if (!nodeMap.has(row.subject)) {
                    nodeMap.set(row.subject, { id: row.subject, type: extractNodeType(row.subject) })
                }
                if (!nodeMap.has(row.object)) {
                    nodeMap.set(row.object, { id: row.object, type: extractNodeType(row.object) })
                }
                edges.push({ source: row.subject, relation: row.relation, target: row.object })
            }

            return reply.status(200).send({
                nodes: [...nodeMap.values()],
                edges,
                total_nodes: nodeMap.size,
                total_edges: edges.length,
                search: search ?? null,
            })

        } catch (error) {
            logger.error({ error: (error as Error).message, tenantId }, 'graph_route_failed')
            return reply.status(500).send({ error: 'internal_error' })
        }
    })
}
