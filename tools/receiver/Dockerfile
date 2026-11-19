# Test receiver image (no runtime dependencies: only Node's standard library).
FROM node:26-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-4000}/healthz" > /dev/null || exit 1
CMD ["node", "src/server.ts"]
