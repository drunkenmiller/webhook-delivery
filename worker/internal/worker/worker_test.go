package worker

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lucianpantoja/webhook-delivery/worker/internal/backoff"
	"github.com/lucianpantoja/webhook-delivery/worker/internal/sender"
	"github.com/lucianpantoja/webhook-delivery/worker/internal/signature"
	"github.com/lucianpantoja/webhook-delivery/worker/internal/store"
	"github.com/lucianpantoja/webhook-delivery/worker/internal/testdb"
)

var pool *pgxpool.Pool

func TestMain(m *testing.M) {
	flag.Parse() // testing.Short() reads the -short flag
	if testing.Short() {
		os.Exit(m.Run())
	}
	var stop func()
	var err error
	pool, stop, err = testdb.Start(context.Background())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	code := m.Run()
	stop()
	os.Exit(code)
}

func setup(t *testing.T) {
	t.Helper()
	if testing.Short() {
		t.Skip("needs Docker")
	}
	testdb.Reset(t, pool)
}

func newWorker(maxAttempts int) *Worker {
	opts := Options{
		WorkerID:      "test-worker",
		Concurrency:   4,
		BatchSize:     4,
		PollInterval:  20 * time.Millisecond,
		LeaseDuration: 30 * time.Second,
		ShutdownGrace: 5 * time.Second,
		MaxAttempts:   maxAttempts,
		// Retry immediately: the random draw is always 0.
		Backoff: backoff.Policy{Base: time.Millisecond, Cap: time.Millisecond, Rand: func(int64) int64 { return 0 }},
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	// allowPrivate: httptest listens on 127.0.0.1.
	return New(store.New(pool), sender.New(2*time.Second, true), opts, log)
}

// start runs the worker in the background; the returned function stops it and waits.
func start(t *testing.T, w *Worker) (stop func()) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- w.Run(ctx) }()
	return func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
	}
}

// waitFor polls a SQL count until it reaches want (or fails after 10 s).
func waitFor(t *testing.T, want int, sql string, args ...any) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var n int
		if err := pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out: %q = %d, want %d", sql, n, want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestDeliversSignedWebhooks(t *testing.T) {
	setup(t)
	var verified atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		ts, _ := strconv.ParseInt(r.Header.Get("webhook-timestamp"), 10, 64)
		want, _ := signature.Sign(testdb.Secret, r.Header.Get("webhook-id"), ts, body)
		if r.Header.Get("webhook-signature") != want {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		verified.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	testdb.Seed(t, pool, server.URL+"/hook", 10)
	stop := start(t, newWorker(8))
	waitFor(t, 10, `SELECT count(*) FROM deliveries WHERE status = 'succeeded'`)
	stop()

	if verified.Load() != 10 {
		t.Errorf("receiver verified %d signatures, want 10", verified.Load())
	}
	waitFor(t, 10, `SELECT count(*) FROM attempts WHERE status_code = 204 AND attempt_number = 1`)
}

func TestRetriesThenDead(t *testing.T) {
	setup(t)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer server.Close()

	ids := testdb.Seed(t, pool, server.URL, 1)
	stop := start(t, newWorker(3))
	waitFor(t, 1, `SELECT count(*) FROM deliveries WHERE id = $1 AND status = 'dead'`, ids[0])
	stop()

	if calls.Load() != 3 {
		t.Errorf("endpoint called %d times, want 3 (MAX_ATTEMPTS)", calls.Load())
	}
	var attemptCount int
	var lastError string
	_ = pool.QueryRow(context.Background(), `SELECT attempt_count, last_error FROM deliveries WHERE id = $1`,
		ids[0]).Scan(&attemptCount, &lastError)
	if attemptCount != 3 || lastError != "HTTP 500" {
		t.Errorf("attempt_count=%d last_error=%q", attemptCount, lastError)
	}
	waitFor(t, 3, `SELECT count(*) FROM attempts WHERE delivery_id = $1 AND response_body_snippet LIKE 'boom%'`, ids[0])
}

func TestRecoversAfterTransientFailures(t *testing.T) {
	setup(t)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) <= 2 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	ids := testdb.Seed(t, pool, server.URL, 1)
	stop := start(t, newWorker(8))
	waitFor(t, 1, `SELECT count(*) FROM deliveries WHERE id = $1 AND status = 'succeeded' AND attempt_count = 3`, ids[0])
	stop()
}

// SIGTERM while a request is in flight: the worker stops claiming but lets it finish and record.
func TestGracefulShutdownFinishesInFlightDeliveries(t *testing.T) {
	setup(t)
	arrived := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		arrived <- struct{}{}
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	ids := testdb.Seed(t, pool, server.URL, 1)
	stop := start(t, newWorker(8))
	<-arrived
	stop() // cancels while the receiver is still sleeping; returns only after the delivery ends

	waitFor(t, 1, `SELECT count(*) FROM deliveries WHERE id = $1 AND status = 'succeeded'`, ids[0])
}
