/**
 * Admin Dashboard route — serves the dashboard at /admin
 * Modular: HTML, CSS, JS served as separate files.
 */
import type { FastifyInstance } from 'fastify'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dashboardDir = join(__dirname, '..', 'dashboard')

function loadFile(filename: string, fallback: string): string {
    const path = join(dashboardDir, filename)
    try {
        if (existsSync(path)) return readFileSync(path, 'utf-8')
    } catch { /* ignore */ }
    return fallback
}

// Load dashboard files once at startup
const dashboardHtml = loadFile('index.html', '<html><body><h1>Dashboard not found</h1></body></html>')
const dashboardCss = loadFile('styles.css', '')
const dashboardJs = loadFile('app.js', '')

export async function adminRoute(fastify: FastifyInstance): Promise<void> {
    // Serve dashboard HTML
    fastify.get('/admin', async (_request, reply) => {
        return reply.type('text/html').send(dashboardHtml)
    })

    // Serve CSS
    fastify.get('/admin/styles.css', async (_request, reply) => {
        return reply.type('text/css').send(dashboardCss)
    })

    // Serve JS
    fastify.get('/admin/app.js', async (_request, reply) => {
        return reply.type('application/javascript').send(dashboardJs)
    })
}
