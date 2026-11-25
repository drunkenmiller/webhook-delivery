// Package backoff computes retry delays: exponential backoff with full jitter (ADR 0006).
//
//	delay = random(0, min(cap, base × 2^(attempts−1)))
//
// Exponential: a struggling endpoint gets more and more breathing room. Full jitter: deliveries
// that failed together (an endpoint went down) don't all retry at the same instant.
package backoff

import (
	"math/rand/v2"
	"time"
)

// Policy holds the retry settings. Rand returns a uniform int64 in [0, n); tests replace it to
// make the "random" part predictable.
type Policy struct {
	Base time.Duration
	Cap  time.Duration
	Rand func(n int64) int64
}

// New returns a policy using math/rand/v2 (automatically seeded; no crypto needed for jitter).
func New(base, cap time.Duration) Policy {
	return Policy{Base: base, Cap: cap, Rand: rand.Int64N}
}

// Delay returns how long to wait before the next try, after `attempts` failed attempts (≥ 1).
func (p Policy) Delay(attempts int) time.Duration {
	return time.Duration(p.Rand(int64(p.Ceiling(attempts)) + 1)) // +1: the ceiling itself is possible
}

// Ceiling is the upper bound of the random delay: min(Cap, Base × 2^(attempts−1)).
func (p Policy) Ceiling(attempts int) time.Duration {
	ceiling := p.Base
	// Double step by step instead of computing 2^n directly: stops as soon as the cap is reached,
	// so a large attempt count can't overflow int64 (like a signed shift overflow in C).
	for i := 1; i < attempts && ceiling < p.Cap; i++ {
		ceiling *= 2
	}
	return min(ceiling, p.Cap)
}
