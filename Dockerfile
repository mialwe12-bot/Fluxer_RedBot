# ---------- Build-Stage: Abhängigkeiten (inkl. better-sqlite3) und TypeScript kompilieren
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- Laufzeit-Stage: schlank, ohne Compiler, als Nicht-root-User
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    TZ=Europe/Berlin \
    DATA_DIR=/data
# git: Downloader-Cog; tini: sauberes Signal-Handling; tzdata: Zeitzone Europe/Berlin
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tzdata tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY locales ./locales
COPY cogs ./cogs
# /app/.cogcache: hier bündelt der Cog-Loader Cogs zur Laufzeit (muss beschreibbar sein)
RUN mkdir -p /data /app/.cogcache && chown -R node:node /data /app/.cogcache
USER node
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
