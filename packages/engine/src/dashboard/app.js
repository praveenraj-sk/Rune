/* ── Rune Dashboard — Enterprise JavaScript ── */

let API_KEY = '', BASE_URL = '', currentPage = 1, currentSearch = '', currentLogFilter = 'all', allLogs = [], searchTimeout = null;

function getBaseUrl() { return window.location.origin }

/* ── Auth ── */
async function authenticate() {
    const key = document.getElementById('authKey').value.trim();
    if (!key) { document.getElementById('authError').textContent = 'Please enter your API key'; return }
    BASE_URL = getBaseUrl();
    try {
        const r = await fetch(BASE_URL + '/v1/health');
        if (!r.ok) throw new Error('Engine unreachable');
        const s = await fetch(BASE_URL + '/v1/stats', { headers: { 'x-api-key': key } });
        if (s.status === 401) { document.getElementById('authError').textContent = 'Invalid API key'; return }
        if (!s.ok) throw new Error('Connection failed');
        API_KEY = key; localStorage.setItem('rune_key', key);
        document.getElementById('authScreen').style.display = 'none';
        document.getElementById('layout').style.display = 'flex';
        loadAll();
    } catch (e) { document.getElementById('authError').textContent = e.message }
}

function logout() {
    API_KEY = ''; localStorage.removeItem('rune_key');
    document.getElementById('layout').style.display = 'none';
    document.getElementById('authScreen').style.display = 'flex';
    document.getElementById('authKey').value = '';
    document.getElementById('authError').textContent = '';
}

window.addEventListener('DOMContentLoaded', () => {
    const k = localStorage.getItem('rune_key');
    if (k) { document.getElementById('authKey').value = k; authenticate() }
});
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('authKey').addEventListener('keydown', e => { if (e.key === 'Enter') authenticate() });
});

/* ── API ── */
async function api(m, p, b) {
    const o = { method: m, headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' } };
    if (b) o.body = JSON.stringify(b);
    const r = await fetch(BASE_URL + p, o);
    if (r.status === 401) { logout(); throw new Error('Unauthorized') }
    return r.json();
}

async function loadAll() { await Promise.all([loadStats(), loadTuples(), loadLogs(), loadSettings()]) }

/* ── Stats ── */
async function loadStats() {
    try {
        const d = await api('GET', '/v1/stats');
        document.getElementById('statTuples').textContent = d.total_tuples.toLocaleString();
        document.getElementById('statDecisions').textContent = d.decisions_today.toLocaleString();
        document.getElementById('statDecisionsSub').textContent = d.allow_today + ' allowed, ' + d.deny_today + ' denied';
        document.getElementById('statLatency').textContent = d.avg_latency_ms.toFixed(1);
        const rate = d.decisions_today > 0 ? Math.round(d.allow_today / d.decisions_today * 1000) / 10 : 0;
        document.getElementById('statAllowRate').textContent = rate + '%';
        document.getElementById('statCacheSub').textContent = 'Cache: ' + d.cache_stats.size + ' / ' + d.cache_stats.maxSize;
    } catch (e) { }
}

/* ── Recent Logs ── */
async function loadRecentLogs() {
    try {
        const d = await api('GET', '/v1/logs');
        const t = document.getElementById('recentLogs');
        if (!d.logs.length) { t.innerHTML = '<tr><td colspan="6" class="empty"><p>No decisions yet</p></td></tr>'; return }
        t.innerHTML = d.logs.slice(0, 8).map(l =>
            '<tr><td class="mono">' + esc(l.subject) +
            '</td><td class="mono">' + esc(l.action) +
            '</td><td class="mono">' + esc(l.object) +
            '</td><td><span class="pill pill-' + (l.status === 'ALLOW' ? 'allow' : l.status === 'NOT_FOUND' ? 'notfound' : 'deny') + '">' + esc(l.status) +
            '</span></td><td class="text-muted">' + parseFloat(l.latency_ms).toFixed(1) + 'ms' +
            '</td><td class="text-muted">' + timeAgo(l.created_at) + '</td></tr>'
        ).join('');
    } catch (e) { }
}

/* ── Tuples ── */
async function loadTuples(page, search) {
    page = page || 1; search = search || ''; currentPage = page; currentSearch = search;
    try {
        const p = new URLSearchParams({ page: String(page), limit: '20' });
        if (search) p.set('search', search);
        const d = await api('GET', '/v1/tuples?' + p);
        const t = document.getElementById('tuplesBody');
        if (!d.tuples.length) {
            t.innerHTML = '<tr><td colspan="5" class="empty"><p>No relationships found</p></td></tr>';
        } else {
            t.innerHTML = d.tuples.map(r =>
                '<tr><td class="mono">' + esc(r.subject) +
                '</td><td><span class="pill pill-relation">' + esc(r.relation) +
                '</span></td><td class="mono">' + esc(r.object) +
                '</td><td class="text-muted">' + timeAgo(r.created_at) +
                '</td><td><button class="btn btn-remove btn-sm" onclick="removeTuple(\'' + esc(r.subject) + '\',\'' + esc(r.relation) + '\',\'' + esc(r.object) + '\')">Remove</button></td></tr>'
            ).join('');
        }
        const pg = document.getElementById('pagination');
        if (d.pages > 1) {
            pg.innerHTML = '<button class="page-btn" onclick="loadTuples(' + (page - 1) + ',\'' + esc(search) + '\')" ' + (page <= 1 ? 'disabled' : '') + '>Prev</button>' +
                '<span class="page-info">Page ' + page + ' of ' + d.pages + ' (' + d.total + ' total)</span>' +
                '<button class="page-btn" onclick="loadTuples(' + (page + 1) + ',\'' + esc(search) + '\')" ' + (page >= d.pages ? 'disabled' : '') + '>Next</button>';
        } else {
            pg.innerHTML = d.total > 0 ? '<span class="page-info">' + d.total + ' relationship' + (d.total === 1 ? '' : 's') + '</span>' : '';
        }
    } catch (e) { }
}

function debouncedSearch() { clearTimeout(searchTimeout); searchTimeout = setTimeout(() => loadTuples(1, document.getElementById('tupleSearch').value), 300) }
function showAddModal() { document.getElementById('addModal').classList.add('show') }
function hideAddModal() { document.getElementById('addModal').classList.remove('show');['addSubject', 'addRelation', 'addObject'].forEach(i => document.getElementById(i).value = '') }

async function addTuple() {
    const s = document.getElementById('addSubject').value.trim(),
        r = document.getElementById('addRelation').value.trim(),
        o = document.getElementById('addObject').value.trim();
    if (!s || !r || !o) return;
    try {
        await api('POST', '/v1/tuples', { subject: s, relation: r, object: o });
        hideAddModal();
        loadTuples(currentPage, currentSearch);
        loadStats();
    } catch (e) { alert('Failed: ' + e.message) }
}

async function removeTuple(s, r, o) {
    if (!confirm('Remove: ' + s + ' → ' + r + ' → ' + o + '?')) return;
    try {
        await api('DELETE', '/v1/tuples', { subject: s, relation: r, object: o });
        loadTuples(currentPage, currentSearch);
        loadStats();
    } catch (e) { alert('Failed: ' + e.message) }
}

/* ── Logs ── */
async function loadLogs() {
    try { const d = await api('GET', '/v1/logs'); allLogs = d.logs; renderLogs(); loadRecentLogs() } catch (e) { }
}

function renderLogs() {
    const f = currentLogFilter === 'all' ? allLogs : allLogs.filter(l => currentLogFilter === 'allow' ? l.status === 'ALLOW' : l.status !== 'ALLOW');
    const t = document.getElementById('logsBody');
    if (!f.length) { t.innerHTML = '<tr><td colspan="8" class="empty"><p>No matching logs</p></td></tr>'; return }
    t.innerHTML = f.map(l =>
        '<tr><td class="mono">' + esc(l.subject) +
        '</td><td class="mono">' + esc(l.action) +
        '</td><td class="mono">' + esc(l.object) +
        '</td><td><span class="pill pill-' + (l.status === 'ALLOW' ? 'allow' : l.status === 'NOT_FOUND' ? 'notfound' : 'deny') + '">' + esc(l.status) +
        '</span></td><td class="text-muted" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(l.reason || '—') +
        '</td><td class="text-muted">' + parseFloat(l.latency_ms).toFixed(1) + 'ms' +
        '</td><td class="text-muted">' + (l.cache_hit ? 'Cache' : 'Live') +
        '</td><td class="text-muted">' + timeAgo(l.created_at) + '</td></tr>'
    ).join('');
}

function filterLogs(type, el) {
    currentLogFilter = type;
    document.querySelectorAll('.filters .btn-ghost').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
    renderLogs();
}

/* ── Permission Debugger ── */
async function runDebugger() {
    const subject = document.getElementById('dbgSubject').value.trim();
    const action = document.getElementById('dbgAction').value.trim();
    const object = document.getElementById('dbgObject').value.trim();
    const tenant = document.getElementById('dbgTenant').value.trim() || 'default';

    if (!subject || !action || !object) {
        alert('Please fill in Subject, Action, and Object');
        return;
    }

    const btn = document.getElementById('dbgRunBtn');
    const resultDiv = document.getElementById('debuggerResult');
    btn.disabled = true;
    btn.textContent = 'Checking...';

    try {
        const result = await api('POST', '/v1/can', { subject, action, object, tenant });

        const isAllow = result.status === 'ALLOW';
        resultDiv.className = 'debugger-result ' + (isAllow ? 'result-allow' : 'result-deny');

        let html = '<div class="result-header">';
        html += '<span class="result-badge ' + (isAllow ? 'badge-allow' : 'badge-deny') + '">';
        html += (isAllow ? '✓' : '✗') + ' ' + result.status;
        html += '</span>';
        html += '<span class="result-latency">' + parseFloat(result.latency_ms).toFixed(2) + 'ms</span>';
        html += '</div>';

        // ReBAC trace
        html += '<div class="trace-section">';
        html += '<div class="trace-title">ReBAC — Graph Traversal</div>';
        if (result.trace && result.trace.length > 0) {
            html += '<div class="trace-item"><span class="trace-check trace-pass">✓</span>';
            html += '<span>Path: <code>' + esc(result.trace.join(' → ')) + '</code></span></div>';
        } else if (result.status === 'NOT_FOUND') {
            html += '<div class="trace-item"><span class="trace-check trace-fail">✗</span>';
            html += '<span>Object not found in store</span></div>';
        } else {
            html += '<div class="trace-item"><span class="trace-check trace-fail">✗</span>';
            html += '<span>No path found from subject to object</span></div>';
        }
        html += '</div>';

        // RBAC
        html += '<div class="trace-section">';
        html += '<div class="trace-title">RBAC — Role Resolution</div>';
        if (result.trace && result.trace.length > 0) {
            html += '<div class="trace-item"><span class="trace-check trace-pass">✓</span>';
            html += '<span>Role grants <code>' + esc(action) + '</code></span></div>';
        } else {
            html += '<div class="trace-item"><span class="trace-check trace-fail">✗</span>';
            html += '<span>No role grants <code>' + esc(action) + '</code></span></div>';
        }
        html += '</div>';

        // ABAC conditions
        if (result.condition_results && result.condition_results.length > 0) {
            html += '<div class="trace-section">';
            html += '<div class="trace-title">ABAC — Conditions</div>';
            for (const c of result.condition_results) {
                html += '<div class="trace-item">';
                html += '<span class="trace-check ' + (c.passed ? 'trace-pass' : 'trace-fail') + '">' + (c.passed ? '✓' : '✗') + '</span>';
                html += '<span><code>' + esc(c.name) + '</code>: ' + esc(c.reason) + '</span>';
                html += '</div>';
            }
            html += '</div>';
        }

        // Reason
        html += '<div class="trace-section">';
        html += '<div class="trace-title">Reason</div>';
        html += '<div class="trace-item" style="font-family:var(--font-mono);font-size:0.8rem;color:var(--gray-600)">';
        html += esc(result.reason || '—');
        html += '</div></div>';

        // Suggested fix
        if (result.suggested_fix && result.suggested_fix.length > 0) {
            html += '<div class="trace-section">';
            html += '<div class="trace-title">Suggested Fix</div>';
            for (const fix of result.suggested_fix) {
                html += '<div class="trace-item" style="font-family:var(--font-mono);font-size:0.78rem">';
                html += esc(fix);
                html += '</div>';
            }
            html += '</div>';
        }

        resultDiv.innerHTML = html;
    } catch (e) {
        resultDiv.className = 'debugger-result result-deny';
        resultDiv.innerHTML = '<div class="result-header"><span class="result-badge badge-deny">✗ ERROR</span></div>' +
            '<div class="trace-item"><span>' + esc(e.message) + '</span></div>';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Check Permission';
    }
}

/* ── Settings ── */
async function loadSettings() {
    document.getElementById('settingsUrl').textContent = BASE_URL;
    document.getElementById('settingsKey').textContent = API_KEY.slice(0, 8) + '••••••••' + API_KEY.slice(-4);
    try {
        const h = await fetch(BASE_URL + '/v1/health').then(r => r.json());
        document.getElementById('settingsStatus').textContent = h.status === 'ok' ? 'Connected' : 'Degraded';
        document.getElementById('settingsDb').textContent = h.db === 'connected' ? 'Connected' : 'Error';
        const s = await api('GET', '/v1/stats');
        document.getElementById('settingsCacheMax').textContent = s.cache_stats.maxSize.toLocaleString();
        document.getElementById('settingsCacheCurrent').textContent = s.cache_stats.size.toLocaleString();
    } catch (e) { }
}

/* ── Navigation ── */
function switchTab(name) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    event.target.closest('.nav-item').classList.add('active');
    document.getElementById('panel-' + name).classList.add('active');
    if (name === 'overview') { loadStats(); loadRecentLogs() }
    if (name === 'relationships') loadTuples(currentPage, currentSearch);
    if (name === 'logs') loadLogs();
    if (name === 'settings') loadSettings();
    if (name === 'graph') loadGraph();
}

/* ── Helpers ── */
function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML }
function timeAgo(d) { const s = (Date.now() - new Date(d).getTime()) / 1000; if (s < 60) return Math.floor(s) + 's ago'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago' }

/* ── Auto Refresh ── */
setInterval(() => { if (API_KEY && document.getElementById('panel-overview').classList.contains('active')) { loadStats(); loadRecentLogs() } }, 10000);

/* ── Graph Visualizer ── */
let graphData = null;
let graphTranslate = { x: 0, y: 0 }, graphScale = 1, graphDragOrigin = null, graphDragTranslate = null;

const NODE_COLORS = { user: '#6366f1', group: '#10b981', zone: '#f59e0b', resource: '#3b82f6' };
function nodeColor(type) { return NODE_COLORS[type] || '#8b5cf6'; }

async function loadGraph(search) {
    const svg = document.getElementById('graphSvg');
    svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#94a3b8" dy="0.35em" font-size="14">Loading graph…</text>';
    document.getElementById('graphEmpty').style.display = 'none';
    document.getElementById('graphStats').textContent = '';
    try {
        const url = '/v1/graph' + (search ? '?search=' + encodeURIComponent(search) : '');
        const data = await api('GET', url);
        graphData = data;
        if (!data.nodes || data.nodes.length === 0) {
            svg.innerHTML = '';
            document.getElementById('graphEmpty').style.display = 'flex';
        } else {
            renderForceGraph(data);
            document.getElementById('graphStats').textContent =
                data.total_nodes + ' nodes · ' + data.total_edges + ' edges' +
                (search ? ' · filtered: ' + search : '');
        }
    } catch (e) {
        svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#ef4444" dy="0.35em" font-size="14">Failed to load graph: ' + esc(e.message) + '</text>';
    }
}

function searchGraph() {
    const s = document.getElementById('graphSearch').value.trim();
    if (s) loadGraph(s);
}
function resetGraph() {
    document.getElementById('graphSearch').value = '';
    loadGraph();
}

function renderForceGraph(data) {
    const container = document.getElementById('graphSvg').parentElement;
    const W = container.clientWidth || 800, H = Math.max(480, container.clientHeight || 560);
    const svg = document.getElementById('graphSvg');
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.innerHTML = '';

    // ── Force layout (simple spring-electrical) ──────────────────────
    const nodes = data.nodes.map((n, i) => ({
        ...n,
        x: W / 2 + (Math.random() - 0.5) * 300,
        y: H / 2 + (Math.random() - 0.5) * 300,
        vx: 0, vy: 0,
    }));
    const nodeById = {};
    nodes.forEach(n => { nodeById[n.id] = n; });

    const edges = data.edges.map(e => ({
        ...e,
        source: nodeById[e.source],
        target: nodeById[e.target],
    })).filter(e => e.source && e.target);

    // Simulate spring forces
    for (let iter = 0; iter < 120; iter++) {
        // Repulsion
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
                const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
                const force = 6000 / (dist * dist);
                const fx = (dx / dist) * force, fy = (dy / dist) * force;
                nodes[i].vx += fx; nodes[i].vy += fy;
                nodes[j].vx -= fx; nodes[j].vy -= fy;
            }
        }
        // Attraction (spring)
        edges.forEach(e => {
            const dx = e.target.x - e.source.x, dy = e.target.y - e.source.y;
            const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
            const force = (dist - 120) * 0.05;
            const fx = (dx / dist) * force, fy = (dy / dist) * force;
            e.source.vx += fx; e.source.vy += fy;
            e.target.vx -= fx; e.target.vy -= fy;
        });
        // Center gravity
        nodes.forEach(n => {
            n.vx += (W / 2 - n.x) * 0.008;
            n.vy += (H / 2 - n.y) * 0.008;
        });
        // Apply velocity + damping
        nodes.forEach(n => {
            n.x += n.vx * 0.6; n.y += n.vy * 0.6;
            n.vx *= 0.5; n.vy *= 0.5;
            n.x = Math.max(30, Math.min(W - 30, n.x));
            n.y = Math.max(30, Math.min(H - 30, n.y));
        });
    }

    // ── SVG elements ─────────────────────────────────────────────────
    const ns = 'http://www.w3.org/2000/svg';

    // Arrow marker
    const defs = document.createElementNS(ns, 'defs');
    const marker = document.createElementNS(ns, 'marker');
    marker.setAttribute('id', 'arrow'); marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '20'); marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '6'); marker.setAttribute('markerHeight', '6');
    marker.setAttribute('orient', 'auto-start-reverse');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z'); path.setAttribute('fill', '#94a3b8');
    marker.appendChild(path); defs.appendChild(marker); svg.appendChild(defs);

    // Pan/zoom group
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('id', 'graphScene');
    g.setAttribute('transform', 'translate(0,0) scale(1)');
    svg.appendChild(g);

    // Edges
    edges.forEach(e => {
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', e.source.x); line.setAttribute('y1', e.source.y);
        line.setAttribute('x2', e.target.x); line.setAttribute('y2', e.target.y);
        line.setAttribute('stroke', '#cbd5e1'); line.setAttribute('stroke-width', '1.5');
        line.setAttribute('marker-end', 'url(#arrow)');
        g.appendChild(line);

        // Edge label
        const mx = (e.source.x + e.target.x) / 2, my = (e.source.y + e.target.y) / 2;
        const label = document.createElementNS(ns, 'text');
        label.setAttribute('x', mx); label.setAttribute('y', my - 4);
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('font-size', '10'); label.setAttribute('fill', '#94a3b8');
        label.setAttribute('font-family', 'Inter,sans-serif');
        label.textContent = e.relation;
        g.appendChild(label);
    });

    // Nodes
    nodes.forEach(n => {
        const nodeG = document.createElementNS(ns, 'g');
        nodeG.style.cursor = 'pointer';

        const circle = document.createElementNS(ns, 'circle');
        circle.setAttribute('cx', n.x); circle.setAttribute('cy', n.y); circle.setAttribute('r', '14');
        circle.setAttribute('fill', nodeColor(n.type));
        circle.setAttribute('stroke', '#fff'); circle.setAttribute('stroke-width', '2');
        nodeG.appendChild(circle);

        const label = document.createElementNS(ns, 'text');
        label.setAttribute('x', n.x); label.setAttribute('y', n.y + 26);
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('font-size', '11'); label.setAttribute('fill', '#475569');
        label.setAttribute('font-family', 'Inter,sans-serif');
        // Truncate long IDs
        const display = n.id.length > 18 ? n.id.slice(0, 16) + '…' : n.id;
        label.textContent = display;
        nodeG.appendChild(label);

        // Hover effect
        circle.addEventListener('mouseenter', () => circle.setAttribute('r', '18'));
        circle.addEventListener('mouseleave', () => circle.setAttribute('r', '14'));

        // Click → show node detail
        nodeG.addEventListener('click', () => showNodeDetail(n, edges));

        g.appendChild(nodeG);
    });

    // ── Pan + zoom ────────────────────────────────────────────────────
    graphTranslate = { x: 0, y: 0 }; graphScale = 1;

    svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        graphScale = Math.max(0.3, Math.min(3, graphScale * (e.deltaY < 0 ? 1.1 : 0.9)));
        updateGraphTransform();
    }, { passive: false });

    svg.addEventListener('mousedown', (e) => {
        graphDragOrigin = { x: e.clientX, y: e.clientY };
        graphDragTranslate = { ...graphTranslate };
    });
    svg.addEventListener('mousemove', (e) => {
        if (!graphDragOrigin) return;
        graphTranslate.x = graphDragTranslate.x + (e.clientX - graphDragOrigin.x);
        graphTranslate.y = graphDragTranslate.y + (e.clientY - graphDragOrigin.y);
        updateGraphTransform();
    });
    svg.addEventListener('mouseup', () => { graphDragOrigin = null; });
    svg.addEventListener('mouseleave', () => { graphDragOrigin = null; });
}

function updateGraphTransform() {
    const scene = document.getElementById('graphScene');
    if (scene) scene.setAttribute('transform', `translate(${graphTranslate.x},${graphTranslate.y}) scale(${graphScale})`);
}

function showNodeDetail(node, edges) {
    const panel = document.getElementById('graphNodePanel');
    document.getElementById('graphNodeTitle').textContent = node.id;
    document.getElementById('graphNodeType').textContent = 'Type: ' + node.type;
    const outgoing = edges.filter(e => e.source.id === node.id);
    const incoming = edges.filter(e => e.target.id === node.id);
    let html = '';
    if (outgoing.length) html += '<div style="font-weight:600;font-size:12px;margin-bottom:4px">Outgoing</div>' + outgoing.map(e => `<div style="font-size:12px;color:#64748b">→ <b>${esc(e.relation)}</b> → ${esc(e.target.id)}</div>`).join('');
    if (incoming.length) html += '<div style="font-weight:600;font-size:12px;margin:6px 0 4px">Incoming</div>' + incoming.map(e => `<div style="font-size:12px;color:#64748b">${esc(e.source.id)} → <b>${esc(e.relation)}</b> →</div>`).join('');
    if (!outgoing.length && !incoming.length) html = '<div style="font-size:12px;color:#94a3b8">No connections</div>';
    document.getElementById('graphNodeRelations').innerHTML = html;
    panel.style.display = 'block';
}

