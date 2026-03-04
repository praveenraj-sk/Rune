# ─────────────────────────────────────────────────────────
# Rune — Authorization-as-Code Engine
#
# Build:  docker build -t runeauth/rune .
# Run:    docker run -p 4078:4078 runeauth/rune
# ─────────────────────────────────────────────────────────

# Stage 1: Builder
FROM node:22-alpine AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Copy lockfile and all package configs (for layer caching)
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY packages/engine/package.json ./packages/engine/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/core/package.json ./packages/core/
COPY packages/cli/package.json ./packages/cli/

# Fetch + install dependencies (cached layer)
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN pnpm build
RUN pnpm --filter core build
RUN pnpm --filter cli build

# ─────────────────────────────────────────────────────────
# Stage 2: Production
FROM node:22-alpine AS runner

WORKDIR /app

# Copy workspace config
COPY --from=builder /app/package.json .
COPY --from=builder /app/pnpm-workspace.yaml .
COPY --from=builder /app/pnpm-lock.yaml .

# Copy engine
COPY --from=builder /app/packages/engine/package.json ./packages/engine/
COPY --from=builder /app/packages/engine/dist ./packages/engine/dist
COPY --from=builder /app/packages/engine/src/db/schema.sql ./packages/engine/src/db/schema.sql

# Copy SDK (engine workspace dependency)
COPY --from=builder /app/packages/sdk/package.json ./packages/sdk/
COPY --from=builder /app/packages/sdk/dist ./packages/sdk/dist

# Copy Core (new — portable BFS engine)
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/core/dist ./packages/core/dist

# Copy CLI (new — rune init/validate/explain)
COPY --from=builder /app/packages/cli/package.json ./packages/cli/
COPY --from=builder /app/packages/cli/dist ./packages/cli/dist

# Copy rune.config.yml if it exists
COPY --from=builder /app/rune.config.yml ./rune.config.yml

# Install production dependencies only
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

ENV NODE_ENV=production
EXPOSE 4078

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4078/v1/health || exit 1

CMD ["pnpm", "--filter", "@rune/engine", "start"]
