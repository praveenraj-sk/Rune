/**
 * DataSource — interface for reading relationships from external databases.
 *
 * This is the core of Zero-Sync: instead of duplicating data into Rune,
 * Rune reads relationships directly from the application's existing database.
 *
 * @example
 * ```ts
 * // Define a datasource in rune.config.yml:
 * datasources:
 *   app_db:
 *     type: postgres
 *     url: $DATABASE_URL        # reads from env var
 *     mappings:
 *       project_members:
 *         subject: "user:{{user_id}}"
 *         relation: "{{role}}"
 *         object: "project:{{project_id}}"
 * ```
 */

export type DataSourceMapping = {
    /** Table name in the app's database */
    table: string
    /** Template for subject: e.g. "user:{{user_id}}" */
    subject: string
    /** Template for relation: e.g. "{{role}}" or a fixed string like "member" */
    relation: string
    /** Template for object: e.g. "project:{{project_id}}" */
    object: string
    /** Optional WHERE clause for filtering */
    where?: string
}

export type DataSourceConfig = {
    type: 'postgres' | 'mysql' | 'sqlite'
    /** Connection URL — supports $ENV_VAR syntax */
    url: string
    mappings: Record<string, DataSourceMapping>
}

export type ExternalTuple = {
    subject: string
    relation: string
    object: string
    source: string  // e.g. "app_db.project_members"
}

/**
 * DataSource interface — implemented by database adapters.
 */
export interface DataSource {
    /** Get tuples for a given subject (outgoing edges) */
    getEdgesForSubjects(subjects: string[]): Promise<ExternalTuple[]>

    /** Check if an object exists */
    objectExists(object: string): Promise<boolean>

    /** Disconnect / cleanup */
    close(): Promise<void>
}
