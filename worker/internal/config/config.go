// Package config reads the worker settings from environment variables (SPEC §7) and fails fast
// on anything invalid, like the API's config.ts does with zod.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	DatabaseURL         string
	WorkerID            string        // locked_by value; must be unique per process
	Concurrency         int           // deliveries sent at the same time
	BatchSize           int           // max rows per claim
	PollInterval        time.Duration // sleep when nothing was due
	LeaseDuration       time.Duration // how long a claim is ours
	RequestTimeout      time.Duration // per HTTP request
	MaxAttempts         int
	BackoffBase         time.Duration
	BackoffCap          time.Duration
	ShutdownGrace       time.Duration // time in-flight deliveries get after SIGTERM
	AllowPrivateTargets bool          // SSRF guard off (local development only)
	LogLevel            slog.Level
}

// leaseMargin: the lease must outlive the request by this much, so a worker never sends a
// request whose lease could expire before the response arrives (SPEC §4 rule 3).
const leaseMargin = 5 * time.Second

// Load reads the configuration; getenv is os.Getenv in production and a map lookup in tests.
func Load(getenv func(string) string) (Config, error) {
	p := parser{getenv: getenv}
	c := Config{
		DatabaseURL:         p.str("DATABASE_URL", ""),
		WorkerID:            p.str("WORKER_ID", defaultWorkerID()),
		Concurrency:         p.positiveInt("CONCURRENCY", 8),
		PollInterval:        p.duration("POLL_INTERVAL", 500*time.Millisecond),
		LeaseDuration:       p.duration("LEASE_DURATION", 30*time.Second),
		RequestTimeout:      p.duration("REQUEST_TIMEOUT", 10*time.Second),
		MaxAttempts:         p.positiveInt("MAX_ATTEMPTS", 8),
		BackoffBase:         p.duration("BACKOFF_BASE", 5*time.Second),
		BackoffCap:          p.duration("BACKOFF_CAP", time.Hour),
		ShutdownGrace:       p.duration("SHUTDOWN_GRACE", 25*time.Second),
		AllowPrivateTargets: p.boolean("ALLOW_PRIVATE_TARGETS", false),
		LogLevel:            p.logLevel("LOG_LEVEL", slog.LevelInfo),
	}
	c.BatchSize = p.positiveInt("BATCH_SIZE", c.Concurrency)

	if c.DatabaseURL == "" {
		p.fail("DATABASE_URL is required")
	}
	if c.LeaseDuration < c.RequestTimeout+leaseMargin {
		p.fail(fmt.Sprintf("LEASE_DURATION (%v) must be at least REQUEST_TIMEOUT (%v) + %v",
			c.LeaseDuration, c.RequestTimeout, leaseMargin))
	}
	if c.BackoffCap < c.BackoffBase {
		p.fail("BACKOFF_CAP must be >= BACKOFF_BASE")
	}
	if len(p.errs) > 0 {
		return Config{}, errors.Join(p.errs...) // report every problem at once
	}
	return c, nil
}

// hostname-pid: unique per process on one machine, readable in logs and in deliveries.locked_by.
func defaultWorkerID() string {
	host, err := os.Hostname()
	if err != nil {
		host = "worker"
	}
	return fmt.Sprintf("%s-%d", host, os.Getpid())
}

// parser collects errors instead of stopping at the first one.
type parser struct {
	getenv func(string) string
	errs   []error
}

func (p *parser) fail(msg string) { p.errs = append(p.errs, errors.New(msg)) }

func (p *parser) str(name, def string) string {
	if v := strings.TrimSpace(p.getenv(name)); v != "" {
		return v
	}
	return def
}

func (p *parser) positiveInt(name string, def int) int {
	v := p.str(name, "")
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		p.fail(fmt.Sprintf("%s must be a positive integer, got %q", name, v))
		return def
	}
	return n
}

// Go duration syntax: "500ms", "30s", "1h".
func (p *parser) duration(name string, def time.Duration) time.Duration {
	v := p.str(name, "")
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		p.fail(fmt.Sprintf("%s must be a positive duration like 500ms or 30s, got %q", name, v))
		return def
	}
	return d
}

func (p *parser) boolean(name string, def bool) bool {
	switch v := strings.ToLower(p.str(name, "")); v {
	case "":
		return def
	case "true", "1", "yes", "on":
		return true
	case "false", "0", "no", "off":
		return false
	default:
		p.fail(fmt.Sprintf("%s must be true or false, got %q", name, v))
		return def
	}
}

func (p *parser) logLevel(name string, def slog.Level) slog.Level {
	v := p.str(name, "")
	if v == "" {
		return def
	}
	var level slog.Level
	if err := level.UnmarshalText([]byte(v)); err != nil {
		p.fail(fmt.Sprintf("%s must be debug, info, warn or error, got %q", name, v))
		return def
	}
	return level
}
