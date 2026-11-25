package config

import (
	"strings"
	"testing"
	"time"
)

func env(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

func TestLoadDefaults(t *testing.T) {
	c, err := Load(env(map[string]string{"DATABASE_URL": "postgres://x"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Concurrency != 8 || c.BatchSize != 8 || c.MaxAttempts != 8 {
		t.Errorf("counts = %d/%d/%d, want 8/8/8", c.Concurrency, c.BatchSize, c.MaxAttempts)
	}
	if c.LeaseDuration != 30*time.Second || c.RequestTimeout != 10*time.Second {
		t.Errorf("lease/timeout = %v/%v", c.LeaseDuration, c.RequestTimeout)
	}
	if c.AllowPrivateTargets {
		t.Error("AllowPrivateTargets must default to false (safe in production)")
	}
	if c.WorkerID == "" {
		t.Error("WorkerID must default to hostname-pid")
	}
}

func TestBatchSizeDefaultsToConcurrency(t *testing.T) {
	c, err := Load(env(map[string]string{"DATABASE_URL": "postgres://x", "CONCURRENCY": "3"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.BatchSize != 3 {
		t.Errorf("BatchSize = %d, want 3", c.BatchSize)
	}
}

func TestLoadReportsEveryError(t *testing.T) {
	_, err := Load(env(map[string]string{
		"CONCURRENCY":     "zero",
		"POLL_INTERVAL":   "500", // missing unit
		"LEASE_DURATION":  "10s", // < REQUEST_TIMEOUT + margin
		"REQUEST_TIMEOUT": "10s",
		"LOG_LEVEL":       "loud",
	}))
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{"DATABASE_URL", "CONCURRENCY", "POLL_INTERVAL", "LEASE_DURATION", "LOG_LEVEL"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %s", err, want)
		}
	}
}
