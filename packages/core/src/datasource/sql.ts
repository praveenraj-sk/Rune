/**
 * SQL DataSource — reads relationships from existing Postgres/MySQL/SQLite databases.
 *
 * Zero-Sync: No data duplication. Rune queries your app's existing tables.
 *
 * @example
 * Given this table in your app's DB:
 * ```sql
 * CREATE TABLE project_members (
 *   user_id   TEXT,
 *   project_id TEXT,
 *   role       TEXT    -- 'admin', 'member', etc.
 * );
 * ```
 *
 * And this mapping:
 * ```yaml
 * project_members:
 *   subject: "user:{{user_id}}"
 *   relation: "{{role}}"
 *   object: "project:{{project_id}}"
 * ```
 *
 * Rune generates:
 * ```sql
 * SELECT user_id, role, project_id
 * FROM project_members
 * WHERE user_id = $1
 * ```
 *
 * And maps results to tuples:
 *   { subject: 'user:42', relation: 'admin', object: 'project:7' }
 */
import type { DataSource, DataSourceConfig, DataSourceMapping, ExternalTuple } from './types.js'

// Column extraction regex: finds {{column_name}} in templates
const COLUMN_RE = /\{\{(\w+)\}\}/g

type ParsedMapping = {
    table: string
    subjectTemplate: string
    subjectColumns: string[]
    relationTemplate: string
    relationColumns: string[]
    objectTemplate: string
    objectColumns: string[]
    allColumns: string[]
    where?: string
    sourceName: string
}

export class SqlDataSource implements DataSource {
    private readonly config: DataSourceConfig
    private readonly parsedMappings: ParsedMapping[]
    private queryFn: ((sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>) | null = null

    constructor(config: DataSourceConfig, queryFn?: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>) {
        this.config = config
        this.parsedMappings = Object.entries(config.mappings).map(([table, mapping]) =>
            this.parseMapping(table, mapping)
        )
        if (queryFn) this.queryFn = queryFn
    }

    /**
     * Set the query function (for lazy initialization / dependency injection).
     * This allows the datasource to work without bundling a DB driver.
     */
    setQueryFn(fn: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>): void {
        this.queryFn = fn
    }

    async getEdgesForSubjects(subjects: string[]): Promise<ExternalTuple[]> {
        if (!this.queryFn) throw new Error('No query function set. Call setQueryFn() or pass in constructor.')

        const results: ExternalTuple[] = []

        for (const mapping of this.parsedMappings) {
            for (const subject of subjects) {
                // Try to match subject against template to extract column values
                const subjectValues = this.extractValues(subject, mapping.subjectTemplate, mapping.subjectColumns)
                if (!subjectValues) continue // Subject doesn't match this mapping's pattern

                // Build WHERE clause
                const whereClauses: string[] = []
                const params: unknown[] = []
                let paramIdx = 1

                for (const [col, val] of Object.entries(subjectValues)) {
                    whereClauses.push(`${col} = $${paramIdx}`)
                    params.push(val)
                    paramIdx++
                }

                if (mapping.where) {
                    whereClauses.push(`(${mapping.where})`)
                }

                const sql = `SELECT ${mapping.allColumns.join(', ')} FROM ${mapping.table} WHERE ${whereClauses.join(' AND ')}`
                const rows = await this.queryFn(sql, params)

                for (const row of rows) {
                    results.push({
                        subject: this.applyTemplate(mapping.subjectTemplate, row),
                        relation: this.applyTemplate(mapping.relationTemplate, row),
                        object: this.applyTemplate(mapping.objectTemplate, row),
                        source: mapping.sourceName,
                    })
                }
            }
        }

        return results
    }

    async objectExists(object: string): Promise<boolean> {
        if (!this.queryFn) return false

        for (const mapping of this.parsedMappings) {
            const objectValues = this.extractValues(object, mapping.objectTemplate, mapping.objectColumns)
            if (!objectValues) continue

            const whereClauses: string[] = []
            const params: unknown[] = []
            let paramIdx = 1

            for (const [col, val] of Object.entries(objectValues)) {
                whereClauses.push(`${col} = $${paramIdx}`)
                params.push(val)
                paramIdx++
            }

            const sql = `SELECT 1 FROM ${mapping.table} WHERE ${whereClauses.join(' AND ')} LIMIT 1`
            const rows = await this.queryFn(sql, params)
            if (rows.length > 0) return true
        }

        return false
    }

    async close(): Promise<void> {
        // No-op — the app owns the DB connection
    }

    // ── Private helpers ─────────────────────────────────────

    private parseMapping(table: string, mapping: DataSourceMapping): ParsedMapping {
        const subjectColumns = this.extractColumns(mapping.subject)
        const relationColumns = this.extractColumns(mapping.relation)
        const objectColumns = this.extractColumns(mapping.object)
        const allColumns = [...new Set([...subjectColumns, ...relationColumns, ...objectColumns])]

        return {
            table,
            subjectTemplate: mapping.subject,
            subjectColumns,
            relationTemplate: mapping.relation,
            relationColumns,
            objectTemplate: mapping.object,
            objectColumns,
            allColumns,
            where: mapping.where,
            sourceName: `${table}`,
        }
    }

    private extractColumns(template: string): string[] {
        const cols: string[] = []
        let match: RegExpExecArray | null
        const re = new RegExp(COLUMN_RE.source, COLUMN_RE.flags)
        while ((match = re.exec(template)) !== null) {
            if (match[1]) cols.push(match[1])
        }
        return cols
    }

    /**
     * Extract column values from a concrete string using a template.
     * e.g. extractValues("user:42", "user:{{user_id}}", ["user_id"]) → { user_id: "42" }
     */
    private extractValues(value: string, template: string, columns: string[]): Record<string, string> | null {
        // Build regex from template
        let pattern = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        for (const col of columns) {
            pattern = pattern.replace(`\\{\\{${col}\\}\\}`, '(.+?)')
        }
        pattern = `^${pattern}$`

        const match = new RegExp(pattern).exec(value)
        if (!match) return null

        const result: Record<string, string> = {}
        columns.forEach((col, i) => {
            const captured = match[i + 1]
            if (captured) result[col] = captured
        })
        return result
    }

    /**
     * Apply template with row data.
     * e.g. applyTemplate("user:{{user_id}}", { user_id: "42" }) → "user:42"
     */
    private applyTemplate(template: string, row: Record<string, unknown>): string {
        return template.replace(COLUMN_RE, (_match, col: string) => String(row[col] ?? ''))
    }
}
