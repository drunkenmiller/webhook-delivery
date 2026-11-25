// Command worker delivers webhooks: it claims due deliveries from PostgreSQL and sends them
// (SPEC §7). Run as many copies as needed; FOR UPDATE SKIP LOCKED keeps them from colliding.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lucianpantoja/webhook-delivery/worker/internal/backoff"
	"github.com/lucianpantoja/webhook-delivery/worker/internal/config"
	"github.com/lucianpantoja/webhook-delivery/worker/internal/sender"
	"github.com/lucianpantoja/webhook-delivery/worker/internal/store"
	"github.com/lucianpantoja/webhook-delivery/worker/internal/worker"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "worker:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return fmt.Errorf("invalid configuration:\n%w", err)
	}

	// JSON logs, one object per line, like the API's pino output.
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))

	// ctx is cancelled on SIGINT (Ctrl+C) or SIGTERM (docker stop, platform deploys).
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	poolCfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("DATABASE_URL: %w", err)
	}
	// One connection per concurrent delivery (each one writes its result) + one for claiming.
	poolCfg.MaxConns = int32(min(cfg.Concurrency+1, 64))
	// Open them up front (and keep them): connecting costs a TCP + auth round trip, which should
	// not be paid in the middle of recording a delivery's result.
	poolCfg.MinConns = poolCfg.MaxConns
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return fmt.Errorf("database: %w", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		return fmt.Errorf("database unreachable: %w", err)
	}

	if cfg.AllowPrivateTargets {
		log.Warn("ALLOW_PRIVATE_TARGETS=true: the SSRF guard is off (local development only)")
	}

	w := worker.New(
		store.New(pool),
		sender.New(cfg.RequestTimeout, cfg.AllowPrivateTargets),
		worker.Options{
			WorkerID:      cfg.WorkerID,
			Concurrency:   cfg.Concurrency,
			BatchSize:     cfg.BatchSize,
			PollInterval:  cfg.PollInterval,
			LeaseDuration: cfg.LeaseDuration,
			ShutdownGrace: cfg.ShutdownGrace,
			MaxAttempts:   cfg.MaxAttempts,
			Backoff:       backoff.New(cfg.BackoffBase, cfg.BackoffCap),
		},
		log,
	)
	return w.Run(ctx)
}
