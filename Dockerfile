# syntax=docker/dockerfile:1

# ---- Build stage: compile the frontend and server ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Toolchain for building better-sqlite3's native addon (if no prebuilt binary).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm ci

# Build the client (-> dist) and server (-> dist-server).
COPY . .
RUN npm run build

# Drop dev dependencies so only runtime deps ship in the final image.
RUN npm prune --omit=dev

# ---- Runtime stage: minimal image that runs the compiled server ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    DATABASE_PATH=/app/data/app.db

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server
COPY --from=builder /app/package.json ./package.json

# Persist the SQLite database outside the image layers.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3001
CMD ["node", "dist-server/server/index.js"]
