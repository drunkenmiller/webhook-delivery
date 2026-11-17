# Production image for the API.
#   docker build -t webhook-delivery-api ./api
#   docker run --rm -p 3000:3000 -e DATABASE_URL=... webhook-delivery-api

# Official Node.js image on Alpine Linux (small). Pinned to the major version used in development.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Copy only the dependency manifests first: Docker caches each step ("layer"), so as long as
# these two files don't change, the slow `npm ci` step is reused on the next build.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Then the source code. Node 24 runs the .ts files directly (type stripping), no build step.
COPY src ./src

# Run as the unprivileged "node" user that the image provides, not as root.
USER node

EXPOSE 3000

# Docker marks the container "unhealthy" if /healthz stops answering. ${PORT:-3000} = PORT or 3000.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" > /dev/null || exit 1

# Exec form (JSON array): node runs as PID 1 and receives SIGTERM directly, so the graceful
# shutdown in src/server.ts works. The shell form would put /bin/sh in between.
CMD ["node", "src/server.ts"]
