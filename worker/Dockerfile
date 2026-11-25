# Production image for the worker. Two stages ("multi-stage build"):
#   1. build: the full Go toolchain compiles one static binary;
#   2. run:   only that binary, on a minimal base — no shell, no package manager, no compiler.
#   docker build -t webhook-delivery-worker worker
#   docker run --rm -e DATABASE_URL=... webhook-delivery-worker

FROM golang:1.27-alpine AS build
WORKDIR /src

# Dependencies first: this layer is cached until go.mod/go.sum change (like `npm ci` in api/).
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# CGO_ENABLED=0: pure Go, statically linked → runs on an image without a C library.
# -trimpath and -ldflags "-s -w": smaller binary, no local paths or debug symbols.
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/worker ./cmd/worker

# distroless "static": CA certificates (needed for https:// endpoints) and a non-root user, nothing else.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/worker /worker
USER nonroot:nonroot
# Exec form: the worker is PID 1 and receives SIGTERM directly → graceful shutdown.
ENTRYPOINT ["/worker"]
