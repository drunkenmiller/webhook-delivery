package backoff

import (
	"testing"
	"time"
)

func TestCeilingDoublesUntilTheCap(t *testing.T) {
	p := New(5*time.Second, time.Hour)
	cases := map[int]time.Duration{
		1:    5 * time.Second,
		2:    10 * time.Second,
		3:    20 * time.Second,
		8:    640 * time.Second,
		10:   2560 * time.Second, // 5 s · 2⁹
		11:   time.Hour,          // 5 s · 2¹⁰ = 5120 s > cap
		1000: time.Hour,          // no overflow
	}
	for attempts, want := range cases {
		if got := p.Ceiling(attempts); got != want {
			t.Errorf("Ceiling(%d) = %v, want %v", attempts, got, want)
		}
	}
}

func TestDelayIsBetweenZeroAndTheCeiling(t *testing.T) {
	p := New(5*time.Second, time.Hour)

	p.Rand = func(int64) int64 { return 0 } // smallest possible draw
	if got := p.Delay(3); got != 0 {
		t.Errorf("Delay with rand=0: %v, want 0", got)
	}

	p.Rand = func(n int64) int64 { return n - 1 } // largest possible draw
	if got := p.Delay(3); got != 20*time.Second {
		t.Errorf("Delay with rand=max: %v, want 20s", got)
	}

	p = New(5*time.Second, time.Hour) // real randomness: always inside the range
	for range 1000 {
		if d := p.Delay(4); d < 0 || d > 40*time.Second {
			t.Fatalf("Delay(4) = %v, outside [0, 40s]", d)
		}
	}
}
