# Contributing Guide

Thank you for contributing to Rune!

---

## Before You Start

1. **Check existing issues** — someone may already be working on it
2. **Open an issue first** for large changes — discuss before coding
3. **Fork the repo** — never push to `main` directly

---

## Branch Naming

```
feat/short-description         # new feature
fix/bug-description            # bug fix
docs/what-you-updated          # documentation only
refactor/what-changed          # refactoring without behavior change
test/what-you-added            # tests only
chore/what-you-did             # config, deps, tooling
```

Examples:
```
feat/wildcard-permissions
fix/bfs-depth-limit-off-by-one
docs/sdk-express-example
```

---

## Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <short description>

<optional longer body explaining why, not what>
```

**Types:** `feat` | `fix` | `docs` | `refactor` | `test` | `chore` | `perf`

Examples:
```
feat: add batch /v1/can endpoint for multiple permission checks

fix: BFS depth limit was off by one — depth 20 would actually allow 21 hops

docs: add Express.js integration example to SDK README

chore: bump @runeauth/sdk to 1.1.0
```

---

## Development Workflow

```bash
# 1. Fork the repo on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/Rune.git
cd Rune

# 2. Set up (see docs/DEVELOPMENT.md)
pnpm install && docker compose up -d && cp .env.example .env && pnpm run setup

# 3. Create a branch
git checkout -b feat/your-feature

# 4. Write code + tests
# ... make changes ...

# 5. Verify everything passes
pnpm test:all && pnpm run typecheck

# 6. Commit
git add -A
git commit -m "feat: describe your change"

# 7. Push and open a PR
git push origin feat/your-feature
```

---

## Pull Request Checklist

Before opening a PR, verify:

- [ ] All 87 tests pass: `pnpm test:all`
- [ ] TypeScript is clean: `pnpm run typecheck`
- [ ] New features have tests
- [ ] Security-related changes include security tests
- [ ] `.env.example` updated if new env vars added
- [ ] `README.md` or `docs/` updated if behavior changed
- [ ] Commit messages follow Conventional Commits format

---

## Code Style

- **TypeScript strict mode** is enabled — no `any` types
- **No `console.log`** in `src/` — use the pino logger: `logger.info(...)` / `logger.debug(...)`
- **Fail closed** — any uncertainty should return `DENY`, never `ALLOW`
- **Parameterized queries** only — no SQL string concatenation ever
- **One export per concern** — don't mix route logic with business logic
- **Comments explain WHY**, not what — the code explains what

---

## Adding a New Route

1. Create `packages/engine/src/routes/your-route.ts`
2. Define body/query schema with JSON Schema (not Zod — Fastify uses JSON Schema for validation)
3. Add `authMiddleware` as `preHandler`
4. Register the route in `packages/engine/src/server.ts`
5. Add integration tests in `packages/engine/tests/integration/`

---

## Adding a New Config Variable

1. Add to `packages/engine/src/config/index.ts` Zod schema
2. Add default value in `loadConfig()`
3. Add to `.env.example` with a comment explaining it
4. Update `docs/DEVELOPMENT.md` config table

---

## Security

- **Never store raw API keys** — always hash with SHA-256 before DB insert
- **All errors return DENY** — wrap uncertain code in try/catch returning deny
- **Tenant isolation** — every DB query must include `tenant_id = $N`
- **No stack traces in responses** — the error handler strips them
- If you find a security vulnerability, **open a private issue** rather than a public PR

---

## Questions?

Open an issue on [GitHub](https://github.com/praveenraj-sk/Rune/issues) with the `question` label.
