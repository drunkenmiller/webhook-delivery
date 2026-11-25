// Package testdb starts a throwaway PostgreSQL 18 in Docker (Testcontainers) with the real
// migrations applied — the Go twin of api/test/integration/global-setup.ts. Tests only.
package testdb

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
)

// Start runs the container and returns a pool plus a cleanup function. Call it from TestMain.
func Start(ctx context.Context) (*pgxpool.Pool, func(), error) {
	ctr, err := postgres.Run(ctx, "postgres:18-alpine",
		postgres.WithDatabase("webhooks"),
		postgres.BasicWaitStrategies(),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("start postgres: %w", err)
	}
	stop := func() { _ = ctr.Terminate(context.Background()) }

	url, err := ctr.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		stop()
		return nil, nil, err
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		stop()
		return nil, nil, err
	}
	if err := applyMigrations(ctx, pool); err != nil {
		pool.Close()
		stop()
		return nil, nil, err
	}
	return pool, func() { pool.Close(); stop() }, nil
}

var (
	upMarker   = regexp.MustCompile(`(?m)^-- migrate:up\b.*$`)
	downMarker = regexp.MustCompile(`(?m)^-- migrate:down\b.*$`)
)

// applyMigrations runs the "-- migrate:up" section of every db/migrations/*.sql, in order.
func applyMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	_, thisFile, _, _ := runtime.Caller(0)
	dir := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "db", "migrations")
	files, err := filepath.Glob(filepath.Join(dir, "*.sql"))
	if err != nil || len(files) == 0 {
		return fmt.Errorf("no migrations found in %s: %v", dir, err)
	}
	sort.Strings(files)
	for _, file := range files {
		sql, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		up := upMarker.FindIndex(sql)
		if up == nil {
			return fmt.Errorf("%s: no migrate:up section", file)
		}
		section := sql[up[1]:]
		if down := downMarker.FindIndex(section); down != nil {
			section = section[:down[0]]
		}
		if _, err := pool.Exec(ctx, strings.TrimSpace(string(section))); err != nil {
			return fmt.Errorf("%s: %w", filepath.Base(file), err)
		}
	}
	return nil
}

// Reset empties every table between tests.
func Reset(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(context.Background(),
		"TRUNCATE applications, endpoints, messages, deliveries, attempts CASCADE")
	if err != nil {
		t.Fatal(err)
	}
}

// Secret is a valid endpoint secret for tests, random for every test run (never a literal in the
// repository: secret scanners flag "whsec_…" strings).
var Secret = randomSecret()

func randomSecret() string {
	key := make([]byte, 32)
	_, _ = rand.Read(key) // crypto/rand.Read never returns an error
	return "whsec_" + base64.StdEncoding.EncodeToString(key)
}

// Seed creates one application, one endpoint pointing at url, and n messages with one pending
// delivery each. It returns the delivery ids.
func Seed(t *testing.T, pool *pgxpool.Pool, url string, n int) []string {
	t.Helper()
	ctx := context.Background()
	var appID, endpointID string
	err := pool.QueryRow(ctx, `INSERT INTO applications (name, api_key_prefix, api_key_hash)
		VALUES ('test', substr(md5(random()::text), 1, 12), sha256(random()::text::bytea)) RETURNING id`).Scan(&appID)
	if err != nil {
		t.Fatal(err)
	}
	err = pool.QueryRow(ctx, `INSERT INTO endpoints (app_id, url, secret) VALUES ($1, $2, $3) RETURNING id`,
		appID, url, Secret).Scan(&endpointID)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := pool.Query(ctx, `
		WITH m AS (
			INSERT INTO messages (app_id, event_type, payload, request_id)
			SELECT $1, 'test.event', jsonb_build_object('n', i), 'req-' || i FROM generate_series(1, $3) i
			RETURNING id
		)
		INSERT INTO deliveries (app_id, message_id, endpoint_id) SELECT $1, m.id, $2 FROM m
		RETURNING id`, appID, endpointID, n)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, n)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return ids
}
