// Package store holds every SQL statement the worker runs: claim and completion (ADR 0002, 0009).
package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Claimed is one delivery this worker now holds a lease on, with everything needed to send it.
type Claimed struct {
	ID           string
	MessageID    string
	EndpointID   string
	ClaimToken   int // claim_count after our claim: the fencing token for Complete
	AttemptCount int // finished attempts before this one
	RequestID    string
	URL          string
	Secret       string
	Payload      []byte // jsonb as text, sent and signed exactly as is
}

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// claimSQL picks the oldest due deliveries and leases them, in ONE statement (= one short
// transaction; no lock is held during the HTTP request).
//
//   - `due` uses the partial index deliveries_due_idx (EXPLAIN in ADR 0009). "Due" covers both
//     a pending delivery whose time has come and an in-flight one whose lease expired, because
//     the claim stores the lease expiry in next_attempt_at.
//   - FOR UPDATE locks the chosen rows until the statement's transaction ends; SKIP LOCKED makes
//     a concurrent worker skip them instead of waiting, so N workers grab N different batches.
//   - claim_count + 1 is the fencing token handed back to us.
//   - The joins fetch the payload and the endpoint in the same round trip.
const claimSQL = `
WITH due AS (
    SELECT id
    FROM deliveries
    WHERE status IN ('pending', 'in_flight') AND next_attempt_at <= now()
    ORDER BY next_attempt_at
    LIMIT $1
    FOR UPDATE SKIP LOCKED
)
UPDATE deliveries d
SET status          = 'in_flight',
    locked_by       = $2,
    locked_until    = now() + make_interval(secs => $3),
    next_attempt_at = now() + make_interval(secs => $3),
    claim_count     = d.claim_count + 1,
    updated_at      = now()
FROM due, messages m, endpoints e
WHERE d.id = due.id AND m.id = d.message_id AND e.id = d.endpoint_id
RETURNING d.id, d.message_id, d.endpoint_id, d.claim_count, d.attempt_count,
          coalesce(m.request_id, ''), e.url, e.secret, m.payload::text`

// Claim leases up to limit due deliveries for workerID.
func (s *Store) Claim(ctx context.Context, workerID string, limit int, lease time.Duration) ([]Claimed, error) {
	rows, err := s.pool.Query(ctx, claimSQL, limit, workerID, lease.Seconds())
	if err != nil {
		return nil, fmt.Errorf("claim: %w", err)
	}
	claimed, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Claimed, error) {
		var c Claimed
		var payload string
		err := row.Scan(&c.ID, &c.MessageID, &c.EndpointID, &c.ClaimToken, &c.AttemptCount,
			&c.RequestID, &c.URL, &c.Secret, &payload)
		c.Payload = []byte(payload)
		return c, err
	})
	if err != nil {
		return nil, fmt.Errorf("claim: %w", err)
	}
	return claimed, nil
}

// Attempt is the row recorded for every HTTP attempt.
type Attempt struct {
	Number     int
	StartedAt  time.Time
	Duration   time.Duration
	StatusCode int // 0 = no response
	Error      string
	Snippet    string
}

// Outcome says what the delivery becomes after the attempt.
type Outcome struct {
	Status     string        // "succeeded", "pending" (retry) or "dead"
	RetryAfter time.Duration // only for "pending": next_attempt_at = now() + RetryAfter
	LastError  string
}

// Complete records the attempt and applies the outcome, in one transaction.
//
// The attempt row is always written: the request WAS sent, even if our lease is gone.
// The delivery update is FENCED (SPEC §4 rule 4): it only applies if the delivery is still
// in flight, held by us, under the same claim. Otherwise another worker re-claimed it after our
// lease expired, its result wins, and Complete returns applied=false.
func (s *Store) Complete(ctx context.Context, workerID string, c Claimed, a Attempt, o Outcome) (applied bool, err error) {
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO attempts (delivery_id, attempt_number, worker_id, started_at, duration_ms,
			                      status_code, error, response_body_snippet)
			VALUES ($1, $2, $3, $4, $5, nullif($6, 0), nullif($7, ''), nullif($8, ''))`,
			c.ID, a.Number, workerID, a.StartedAt, a.Duration.Milliseconds(),
			a.StatusCode, a.Error, a.Snippet,
		); err != nil {
			return fmt.Errorf("insert attempt: %w", err)
		}

		// The database clock (now()) is used for every due time, like in the claim, so clock
		// differences between worker machines don't matter.
		tag, err := tx.Exec(ctx, `
			UPDATE deliveries
			SET status          = $4,
			    attempt_count   = attempt_count + 1,
			    next_attempt_at = CASE WHEN $4 = 'pending' THEN now() + make_interval(secs => $5)
			                           ELSE next_attempt_at END,
			    last_error      = nullif($6, ''),
			    locked_by       = NULL,
			    locked_until    = NULL,
			    updated_at      = now()
			WHERE id = $1 AND status = 'in_flight' AND locked_by = $2 AND claim_count = $3`,
			c.ID, workerID, c.ClaimToken, o.Status, o.RetryAfter.Seconds(), o.LastError,
		)
		if err != nil {
			return fmt.Errorf("complete delivery: %w", err)
		}
		applied = tag.RowsAffected() == 1
		return nil
	})
	return applied, err
}
