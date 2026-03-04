FROM node:22-alpine AS builder

# Install pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Copy lockfile and package configuration
COPY pnpm-lock.yaml ./
COPY package.json pnpm-workspace.yaml ./
COPY packages/engine/package.json ./packages/engine/
COPY packages/sdk/package.json ./packages/sdk/

# Fetch dependencies (layer caching)
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch

# Install all dependencies
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build both engine and sdk (since engine relies on sdk types/interfaces)
RUN pnpm build

# ---
# Production image
FROM node:22-alpine AS runner

WORKDIR /app

# Copy built artifacts from the builder image
COPY --from=builder /app/package.json .
COPY --from=builder /app/pnpm-workspace.yaml .
COPY --from=builder /app/packages/engine/package.json ./packages/engine/
COPY --from=builder /app/packages/engine/dist ./packages/engine/dist
# We need to copy packages/sdk because engine might have a workspace: dependency on it
COPY --from=builder /app/packages/sdk/package.json ./packages/sdk/
COPY --from=builder /app/packages/sdk/dist ./packages/sdk/dist

# Install only production dependencies
# This creates a smaller final image
COPY --from=builder /app/pnpm-lock.yaml .

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

ENV NODE_ENV=production
# Expose the standard Render port (though Render injects PORT env var)
EXPOSE 4078

# Start the engine
CMD ["pnpm", "--filter", "@rune/engine", "start"]
