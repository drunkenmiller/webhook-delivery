// Package worker is the delivery loop (SPEC §7): claim due deliveries, send them concurrently,
// record each attempt and decide what happens next (succeeded, retry later, or dead).
package worker

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/lucianpantoja/webhook-delivery/worker/internal/backoff"
	"github.com/lucianpantoja/webhook-delivery/worker/internal/sender"
	"github.com/lucianpantoja/webhook-delivery/worker/internal/store"
)

// Interfaces for what the loop needs, so tests can swap in fakes (dependency injection, like the
// API's Db type). *store.Store and *sender.Sender satisfy them; Go checks that implicitly.
type Store interface {
	Claim(ctx context.Context, workerID string, limit int, lease time.Duration) ([]store.Claimed, error)
	Complete(ctx context.Context, workerID string, c store.Claimed, a store.Attempt, o store.Outcome) (bool, error)
}

type Sender interface {
	Send(ctx context.Context, req sender.Request) sender.Result
}

type Options struct {
	WorkerID      string
	Concurrency   int
	BatchSize     int
	PollInterval  time.Duration
	LeaseDuration time.Duration
	ShutdownGrace time.Duration
	MaxAttempts   int
	Backoff       backoff.Policy
}

type Worker struct {
	store  Store
	sender Sender
	opts   Options
	log    *slog.Logger
	now    func() time.Time
}

func New(st Store, sd Sender, opts Options, log *slog.Logger) *Worker {
	return &Worker{store: st, sender: sd, opts: opts, log: log.With("worker_id", opts.WorkerID), now: time.Now}
}

// Bounds for the database calls, which deliberately ignore shutdown (see claim and process).
const (
	claimTimeout    = 5 * time.Second
	completeTimeout = 5 * time.Second
)

// Run loops until ctx is cancelled (SIGTERM/SIGINT), then shuts down gracefully:
//  1. stop claiming;
//  2. give deliveries already in flight up to ShutdownGrace to finish and be recorded;
//  3. abort whatever is left. Those rows stay in_flight and come back when their lease expires,
//     so nothing is lost (at-least-once, ADR 0003).
func (w *Worker) Run(ctx context.Context) error {
	// A counting semaphore: a buffered channel with one slot per concurrent delivery. Sending
	// takes a slot (blocks when all are taken), receiving gives it back.
	slots := make(chan struct{}, w.opts.Concurrency)
	var wg sync.WaitGroup // counts running deliveries, like a join on a set of threads

	// Deliveries must outlive ctx (step 2), so they run under a context that ignores ctx's
	// cancellation and is cancelled only by abort (step 3).
	work, abort := context.WithCancel(context.WithoutCancel(ctx))
	defer abort()

	w.log.Info("worker started", "concurrency", w.opts.Concurrency, "batch_size", w.opts.BatchSize)

claimLoop:
	for {
		// Wait for at least one free slot (or shutdown) before claiming anything: claiming rows
		// we can't start yet would just let their leases tick away.
		select {
		case <-ctx.Done():
			break claimLoop
		case slots <- struct{}{}:
		}

		// Only this goroutine takes slots, so the free count can only grow while we claim.
		free := 1 + cap(slots) - len(slots)
		claimed, err := w.claim(ctx, min(free, w.opts.BatchSize))
		if err != nil || len(claimed) == 0 {
			<-slots // give back the slot we took
			if err != nil {
				w.log.Error("claim failed", "err", err) // e.g. database down: retry after a pause
			}
			if !w.sleep(ctx, w.opts.PollInterval) {
				break claimLoop
			}
			continue
		}

		for i, c := range claimed {
			if i > 0 {
				slots <- struct{}{} // never blocks: we claimed at most `free` rows
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer func() { <-slots }()
				w.process(work, c)
			}()
		}
	}

	w.log.Info("shutting down: waiting for in-flight deliveries", "grace", w.opts.ShutdownGrace)
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(w.opts.ShutdownGrace):
		w.log.Warn("shutdown grace period over: aborting in-flight deliveries (their leases will expire)")
		abort()
		<-done
	}
	w.log.Info("worker stopped")
	return nil
}

// claim is NOT cancelled by shutdown: if SIGTERM arrived while the UPDATE was running, the
// database could commit the claim after the client gave up on it, and those rows would sit
// in_flight, unsent, until their lease expired. A short timeout still bounds it.
func (w *Worker) claim(ctx context.Context, limit int) ([]store.Claimed, error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), claimTimeout)
	defer cancel()
	return w.store.Claim(ctx, w.opts.WorkerID, limit, w.opts.LeaseDuration)
}

// sleep waits d or until ctx is cancelled; false means "cancelled, stop".
func (w *Worker) sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// process sends one claimed delivery and records the result.
func (w *Worker) process(ctx context.Context, c store.Claimed) {
	attempt := c.AttemptCount + 1
	log := w.log.With(
		"delivery_id", c.ID, "message_id", c.MessageID, "endpoint_id", c.EndpointID,
		"attempt", attempt, "request_id", c.RequestID,
	)

	started := w.now()
	result := w.sender.Send(ctx, sender.Request{
		URL: c.URL, Secret: c.Secret, MessageID: c.MessageID, Body: c.Payload,
	})
	if ctx.Err() != nil {
		// Aborted by shutdown: not the endpoint's fault, so it doesn't count as an attempt.
		log.Warn("delivery abandoned on shutdown; it will be retried after the lease expires")
		return
	}

	outcome := w.decide(result, attempt)
	errText := ""
	if result.Err != nil {
		errText = result.Err.Error()
	}

	// A fresh timeout for the write: the attempt happened and should be recorded.
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), completeTimeout)
	defer cancel()
	applied, err := w.store.Complete(writeCtx, w.opts.WorkerID, c, store.Attempt{
		Number:     attempt,
		StartedAt:  started,
		Duration:   result.Duration,
		StatusCode: result.StatusCode,
		Error:      errText,
		Snippet:    result.Snippet,
	}, outcome)

	attrs := []any{"status", outcome.Status, "status_code", result.StatusCode,
		"duration_ms", result.Duration.Milliseconds()}
	switch {
	case err != nil:
		// Not recorded: the lease will expire and the delivery will be attempted again.
		log.Error("recording the attempt failed", append(attrs, "err", err)...)
	case !applied:
		log.Warn("lease lost: outcome discarded, another worker owns this delivery now", attrs...)
	case outcome.Status == "succeeded":
		log.Info("delivered", attrs...)
	case outcome.Status == "dead":
		log.Warn("attempts exhausted: delivery is dead", append(attrs, "err", errText)...)
	default:
		log.Info("attempt failed: retry scheduled",
			append(attrs, "err", errText, "retry_in", outcome.RetryAfter.Round(time.Millisecond).String())...)
	}
}

// decide applies SPEC §4 rules 5–6.
func (w *Worker) decide(r sender.Result, attempt int) store.Outcome {
	switch {
	case r.Succeeded():
		return store.Outcome{Status: "succeeded"}
	case attempt >= w.opts.MaxAttempts:
		return store.Outcome{Status: "dead", LastError: r.Err.Error()}
	default:
		return store.Outcome{
			Status:     "pending",
			RetryAfter: w.opts.Backoff.Delay(attempt),
			LastError:  r.Err.Error(),
		}
	}
}
