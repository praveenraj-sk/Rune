/**
 * Admin Dashboard route — serves the dashboard HTML at /admin
 */
import type { FastifyInstance } from 'fastify'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load dashboard HTML once at startup
let dashboardHtml: string
try {
    dashboardHtml = readFileSync(join(__dirname, '..', 'dashboard', 'index.html'), 'utf-8')
} catch {
    dashboardHtml = '<html><body><h1>Dashboard HTML not found</h1></body></html>'
}

export async function adminRoute(fastify: FastifyInstance): Promise<void> {
    // Serve dashboard — no auth, the UI will prompt for API key
    fastify.get('/admin', async (_request, reply) => {
        return reply.type('text/html').send(dashboardHtml)
    })
}
