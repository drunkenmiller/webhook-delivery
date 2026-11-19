# Production image for the API. The build context is the REPOSITORY ROOT, because the npm
# workspace lockfile (package-lock.json) lives there:
#   docker build -f api/Dockerfile -t webhook-delivery-api .
#   docker run --rm -p 3000:3000 -e DATABASE_URL=... webhook-delivery-api

# Official Node.js image on Alpine Linux (small). Pinned to the major version used in development.
FROM node:26-alpine

ENV NODE_ENV=production
WORKDIR /app

# Copy only the dependency manifests first: Docker caches each step ("layer"), so as long as
# these files don't change, the slow `npm ci` step is reused on the next build.
# npm ci checks the lockfile against EVERY workspace's package.json, so all of them are copied.
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY tools/receiver/package.json tools/receiver/
RUN npm ci --workspace api --omit=dev && npm cache clean --force

# Then the source code. Node 24 runs the .ts files directly (type stripping), no build step.
COPY api/src api/src
WORKDIR /app/api

# Run as the unprivileged "node" user that the image provides, not as root.
USER node

EXPOSE 3000

# Docker marks the container "unhealthy" if /healthz stops answering. ${PORT:-3000} = PORT or 3000.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" > /dev/null || exit 1

# Exec form (JSON array): node runs as PID 1 and receives SIGTERM directly, so the graceful
# shutdown in src/server.ts works. The shell form would put /bin/sh in between.
CMD ["node", "src/server.ts"]
