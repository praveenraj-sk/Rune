# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Rune, **please report it privately** — do not open a public GitHub issue.

### How to report

Email **praveenraj.sk@outlook.com** with:

1. A description of the vulnerability
2. Steps to reproduce it
3. The potential impact

### What to expect

- **Acknowledgement** within 48 hours
- A fix or mitigation plan within 7 days
- Credit in the release notes (unless you prefer to stay anonymous)

## Supported Versions

| Version | Supported |
|---|---|
| Latest on `main` | ✅ |
| Older releases | ❌ |

## Security Design

Rune is built with security as a core principle:

- **Fail-closed** — any error returns DENY, never ALLOW
- **Timing-safe** key comparison via `crypto.timingSafeEqual`
- **SHA-256 hashed** API keys — plaintext is never stored
- **Tenant-isolated** — every DB query is scoped to `tenant_id`
- **BFS limits** — configurable `MAX_BFS_DEPTH` and `MAX_BFS_NODES` prevent graph bombs
- **Input validation** — all inputs validated with Zod schemas before processing
