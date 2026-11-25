package store

import (
	"context"
	"flag"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lucianpantoja/webhook-delivery/worker/internal/testdb"
)

var pool *pgxpool.Pool

// TestMain runs once per package: one container for every test here. `go test -short` skips
// the database tests (no Docker needed).
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

func setup(t *testing.T) *Store {
	t.Helper()
	if testing.Short() {
		t.Skip("needs Docker")
	}
	testdb.Reset(t, pool)
	return New(pool)
}

type deliveryRow struct {
	Status       string
	AttemptCount int
	ClaimCount   int
	LockedBy     *string
	LastError    *string
	DueInSeconds float64
}

func readDelivery(t *testing.T, id string) deliveryRow {
	t.Helper()
	var d deliveryRow
	err := pool.QueryRow(context.Background(), `
		SELECT status, attempt_count, claim_count, locked_by, last_error,
		       extract(epoch FROM next_attempt_at - now())::float8
		FROM deliveries WHERE id = $1`, id).
		Scan(&d.Status, &d.AttemptCount, &d.ClaimCount, &d.LockedBy, &d.LastError, &d.DueInSeconds)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func expireLease(t *testing.T, id string) {
	t.Helper()
	_, err := pool.Exec(context.Background(),
		`UPDATE deliveries SET next_attempt_at = now() - interval '1 second',
		                       locked_until = now() - interval '1 second' WHERE id = $1`, id)
	if err != nil {
		t.Fatal(err)
	}
}

func TestClaimLeasesDueDeliveries(t *testing.T) {
	s := setup(t)
	ctx := context.Background()
	ids := testdb.Seed(t, pool, "https://example.com/hook", 3)

	claimed, err := s.Claim(ctx, "w1", 10, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(claimed) != 3 {
		t.Fatalf("claimed %d, want 3", len(claimed))
	}
	c := claimed[0]
	if c.ClaimToken != 1 || c.AttemptCount != 0 || c.URL != "https://example.com/hook" ||
		c.Secret != testdb.Secret || c.RequestID == "" || len(c.Payload) == 0 {
		t.Errorf("claimed row = %+v", c)
	}

	d := readDelivery(t, ids[0])
	if d.Status != "in_flight" || d.LockedBy == nil || *d.LockedBy != "w1" || d.DueInSeconds < 25 {
		t.Errorf("after claim: %+v (want in_flight, locked by w1, due in ~30 s)", d)
	}

	// Leased rows are not due: a second worker gets nothing.
	again, err := s.Claim(ctx, "w2", 10, 30*time.Second)
	if err != nil || len(again) != 0 {
		t.Fatalf("second claim = %d rows, %v; want 0", len(again), err)
	}
}

func TestClaimSkipsFutureRetries(t *testing.T) {
	s := setup(t)
	ids := testdb.Seed(t, pool, "https://example.com/hook", 1)
	_, err := pool.Exec(context.Background(),
		`UPDATE deliveries SET next_attempt_at = now() + interval '1 minute' WHERE id = $1`, ids[0])
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := s.Claim(context.Background(), "w1", 10, 30*time.Second)
	if err != nil || len(claimed) != 0 {
		t.Fatalf("claimed %d, %v; want 0", len(claimed), err)
	}
}

// N3: any number of workers, no delivery claimed twice.
func TestConcurrentClaimsNeverOverlap(t *testing.T) {
	s := setup(t)
	const total = 300
	testdb.Seed(t, pool, "https://example.com/hook", total)

	var mu sync.Mutex
	seen := map[string]int{}
	var wg sync.WaitGroup
	for w := range 6 {
		wg.Go(func() {
			for {
				claimed, err := s.Claim(context.Background(), fmt.Sprintf("w%d", w), 7, 30*time.Second)
				if err != nil {
					t.Error(err)
					return
				}
				if len(claimed) == 0 {
					return
				}
				mu.Lock()
				for _, c := range claimed {
					seen[c.ID]++
				}
				mu.Unlock()
			}
		})
	}
	wg.Wait()

	if len(seen) != total {
		t.Errorf("claimed %d distinct deliveries, want %d", len(seen), total)
	}
	for id, n := range seen {
		if n != 1 {
			t.Errorf("delivery %s claimed %d times", id, n)
		}
	}
}

func TestCompleteSuccess(t *testing.T) {
	s := setup(t)
	ctx := context.Background()
	ids := testdb.Seed(t, pool, "https://example.com/hook", 1)
	claimed, _ := s.Claim(ctx, "w1", 1, 30*time.Second)

	applied, err := s.Complete(ctx, "w1", claimed[0],
		Attempt{Number: 1, StartedAt: time.Now(), Duration: 42 * time.Millisecond, StatusCode: 200, Snippet: "ok"},
		Outcome{Status: "succeeded"})
	if err != nil || !applied {
		t.Fatalf("Complete = %v, %v; want applied", applied, err)
	}
	d := readDelivery(t, ids[0])
	if d.Status != "succeeded" || d.AttemptCount != 1 || d.LockedBy != nil {
		t.Errorf("after success: %+v", d)
	}

	var code, ms int
	if err := pool.QueryRow(ctx, `SELECT status_code, duration_ms FROM attempts WHERE delivery_id = $1`,
		ids[0]).Scan(&code, &ms); err != nil {
		t.Fatal(err)
	}
	if code != 200 || ms != 42 {
		t.Errorf("attempt = %d/%dms", code, ms)
	}
}

func TestCompleteRetryUsesTheDatabaseClock(t *testing.T) {
	s := setup(t)
	ctx := context.Background()
	ids := testdb.Seed(t, pool, "https://example.com/hook", 1)
	claimed, _ := s.Claim(ctx, "w1", 1, 30*time.Second)

	applied, err := s.Complete(ctx, "w1", claimed[0],
		Attempt{Number: 1, StartedAt: time.Now(), Error: "timeout"},
		Outcome{Status: "pending", RetryAfter: 10 * time.Second, LastError: "timeout"})
	if err != nil || !applied {
		t.Fatalf("Complete = %v, %v", applied, err)
	}
	d := readDelivery(t, ids[0])
	if d.Status != "pending" || d.AttemptCount != 1 || d.LastError == nil || *d.LastError != "timeout" ||
		d.DueInSeconds < 8 || d.DueInSeconds > 10 {
		t.Errorf("after failure: %+v (want pending, due in ~10 s)", d)
	}
}

// SPEC §4 rule 4 + ADR 0009: a worker whose lease expired can't overwrite the new owner's result.
func TestStaleCompletionIsFenced(t *testing.T) {
	s := setup(t)
	ctx := context.Background()
	ids := testdb.Seed(t, pool, "https://example.com/hook", 1)

	first, _ := s.Claim(ctx, "w1", 1, 30*time.Second)
	expireLease(t, ids[0]) // w1 is slow; its lease runs out
	second, _ := s.Claim(ctx, "w2", 1, 30*time.Second)
	if len(second) != 1 || second[0].ClaimToken != 2 {
		t.Fatalf("re-claim after expiry = %+v, want token 2", second)
	}

	// w1 finally finishes and reports a failure: discarded, but its attempt is still recorded.
	applied, err := s.Complete(ctx, "w1", first[0], Attempt{Number: 1, StartedAt: time.Now(), Error: "timeout"},
		Outcome{Status: "pending", RetryAfter: time.Minute, LastError: "timeout"})
	if err != nil || applied {
		t.Fatalf("stale Complete = %v, %v; want not applied", applied, err)
	}
	if d := readDelivery(t, ids[0]); d.Status != "in_flight" || *d.LockedBy != "w2" {
		t.Errorf("stale completion changed the delivery: %+v", d)
	}

	applied, err = s.Complete(ctx, "w2", second[0], Attempt{Number: 1, StartedAt: time.Now(), StatusCode: 200},
		Outcome{Status: "succeeded"})
	if err != nil || !applied {
		t.Fatalf("owner Complete = %v, %v", applied, err)
	}
	var attempts int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM attempts WHERE delivery_id = $1`, ids[0]).Scan(&attempts)
	if attempts != 2 {
		t.Errorf("attempts = %d, want 2 (both requests were sent)", attempts)
	}
}

// Why locked_by alone is not enough: the SAME worker id re-claims after its own lease expired.
func TestFencingWorksForTheSameWorkerID(t *testing.T) {
	s := setup(t)
	ctx := context.Background()
	ids := testdb.Seed(t, pool, "https://example.com/hook", 1)

	old, _ := s.Claim(ctx, "w1", 1, 30*time.Second)
	expireLease(t, ids[0])
	current, _ := s.Claim(ctx, "w1", 1, 30*time.Second)

	applied, err := s.Complete(ctx, "w1", old[0], Attempt{Number: 1, StartedAt: time.Now(), StatusCode: 500},
		Outcome{Status: "dead", LastError: "HTTP 500"})
	if err != nil || applied {
		t.Fatalf("Complete with the old token = %v, %v; want not applied", applied, err)
	}
	applied, _ = s.Complete(ctx, "w1", current[0], Attempt{Number: 1, StartedAt: time.Now(), StatusCode: 200},
		Outcome{Status: "succeeded"})
	if !applied {
		t.Fatal("Complete with the current token was not applied")
	}
}
