package signature

import (
	"errors"
	"testing"
)

func TestSignMatchesTheStandardWebhooksVector(t *testing.T) {
	// The official Standard Webhooks test vector; tools/receiver computes the same value.
	got, err := Sign(
		"whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
		"msg_p5jXN8AQM9LWM0D4loKWxJek",
		1614265330,
		[]byte(`{"test": 2432232314}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	want := "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="
	if got != want {
		t.Fatalf("Sign() = %q, want %q", got, want)
	}
}

func TestSignRejectsInvalidSecrets(t *testing.T) {
	for _, secret := range []string{"", "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "whsec_", "whsec_not base64!"} {
		if _, err := Sign(secret, "id", 1, nil); !errors.Is(err, ErrInvalidSecret) {
			t.Errorf("Sign(secret=%q) error = %v, want ErrInvalidSecret", secret, err)
		}
	}
}
