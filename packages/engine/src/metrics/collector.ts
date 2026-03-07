/**
 * In-memory metrics collector — lightweight, zero dependencies.
 *
 * Tracks authorization decision metrics for the /v1/metrics endpoint.
 * All data is kept in memory — resets on server restart (by design,
 * since Prometheus/Grafana scrape periodically and maintain history).
 *
 * Thread-safe: Node.js is single-threaded, so no locks needed.
 *
 * WHAT IT TRACKS:
 * - Cache hit/miss counts
 * - Permission index hit count
 * - BFS depth distribution (histogram)
 * - Latency percentiles (p50, p95, p99) via a rolling window
 * - Total request count by decision (allow/deny)
 * - Error count
 */

/** Rolling window size for latency percentile calculation.
 * At 1000 req/sec, this holds the last ~16 minutes of data. */
const LATENCY_WINDOW_SIZE = 1_000_000

class MetricsCollector {
    // ── Counters ─────────────────────────────────────────────────────────────
    private _totalAllow = 0
    private _totalDeny = 0
    private _cacheHits = 0
    private _cacheMisses = 0
    private _indexHits = 0
    private _errors = 0

    // ── BFS depth histogram ──────────────────────────────────────────────────
    // Key: depth level (0–20), Value: count of decisions at that depth
    private readonly _bfsDepth = new Map<number, number>()

    // ── Latency rolling window ───────────────────────────────────────────────
    // Circular buffer for O(1) insertions. Sorted copy computed on read.
    private readonly _latencies: number[] = []
    private _latencyIdx = 0

    /** Record a completed can() decision. Call this from can.ts after every result. */
    record(result: {
        decision: 'allow' | 'deny'
        cache_hit: boolean
        index_hit: boolean
        latency_ms: number
        bfs_depth?: number
    }): void {
        // Decision counters
        if (result.decision === 'allow') this._totalAllow++
        else this._totalDeny++

        // Cache
        if (result.cache_hit) this._cacheHits++
        else this._cacheMisses++

        // Permission index
        if (result.index_hit) this._indexHits++

        // BFS depth (only recorded when BFS actually ran — not on cache/index hits)
        if (result.bfs_depth !== undefined && result.bfs_depth >= 0 && !result.cache_hit && !result.index_hit) {
            this._bfsDepth.set(result.bfs_depth, (this._bfsDepth.get(result.bfs_depth) ?? 0) + 1)
        }

        // Latency (circular buffer)
        if (this._latencies.length < LATENCY_WINDOW_SIZE) {
            this._latencies.push(result.latency_ms)
        } else {
            this._latencies[this._latencyIdx % LATENCY_WINDOW_SIZE] = result.latency_ms
        }
        this._latencyIdx++
    }

    /** Record an error (failed can() call that returned service_error). */
    recordError(): void {
        this._errors++
    }

    /** Compute and return all metrics as a plain object for JSON serialization. */
    snapshot(): MetricsSnapshot {
        const totalRequests = this._totalAllow + this._totalDeny
        const cacheHitRate = totalRequests > 0
            ? Math.round((this._cacheHits / totalRequests) * 10000) / 100
            : 0

        // Percentiles from the rolling latency window
        const sorted = [...this._latencies].sort((a, b) => a - b)
        const p = (pct: number) => sorted.length > 0
            ? sorted[Math.floor(sorted.length * pct / 100)] ?? 0
            : 0

        // BFS depth histogram as a sorted array
        const bfsHistogram: Array<{ depth: number; count: number }> = []
        for (const [depth, count] of this._bfsDepth) {
            bfsHistogram.push({ depth, count })
        }
        bfsHistogram.sort((a, b) => a.depth - b.depth)

        return {
            total_requests: totalRequests,
            total_allow: this._totalAllow,
            total_deny: this._totalDeny,
            total_errors: this._errors,
            cache_hits: this._cacheHits,
            cache_misses: this._cacheMisses,
            cache_hit_rate_pct: cacheHitRate,
            index_hits: this._indexHits,
            latency_p50_ms: Math.round(p(50) * 100) / 100,
            latency_p95_ms: Math.round(p(95) * 100) / 100,
            latency_p99_ms: Math.round(p(99) * 100) / 100,
            bfs_depth_histogram: bfsHistogram,
            window_size: this._latencies.length,
        }
    }
}

export type MetricsSnapshot = {
    total_requests: number
    total_allow: number
    total_deny: number
    total_errors: number
    cache_hits: number
    cache_misses: number
    cache_hit_rate_pct: number
    index_hits: number
    latency_p50_ms: number
    latency_p95_ms: number
    latency_p99_ms: number
    bfs_depth_histogram: Array<{ depth: number; count: number }>
    window_size: number
}

/** Singleton — one collector for the entire process. */
export const metrics = new MetricsCollector()
