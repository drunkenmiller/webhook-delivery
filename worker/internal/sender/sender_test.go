package sender

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

// Any valid secret works here; the signature itself is checked in package signature.
var testSecret = "whsec_" + base64.StdEncoding.EncodeToString([]byte("sender-test-key-0123456789abcdef"))

func request(url string) Request {
	return Request{URL: url, Secret: testSecret, MessageID: "msg_1", Body: []byte(`{"a":1}`)}
}

func TestSendSignsAndPostsTheBody(t *testing.T) {
	var got *http.Request
	var body string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		b, _ := io.ReadAll(r.Body)
		body = string(b)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()

	result := New(time.Second, true).Send(context.Background(), request(server.URL+"/hook"))

	if !result.Succeeded() || result.StatusCode != 200 || result.Snippet != "ok" {
		t.Fatalf("result = %+v", result)
	}
	if body != `{"a":1}` {
		t.Errorf("body = %q", body)
	}
	for _, h := range []string{"webhook-id", "webhook-timestamp", "webhook-signature"} {
		if got.Header.Get(h) == "" {
			t.Errorf("missing header %s", h)
		}
	}
	if !strings.HasPrefix(got.Header.Get("webhook-signature"), "v1,") {
		t.Errorf("signature = %q", got.Header.Get("webhook-signature"))
	}
	if got.Header.Get("Content-Type") != "application/json" {
		t.Errorf("content-type = %q", got.Header.Get("Content-Type"))
	}
}

func TestNon2xxAndRedirectsFail(t *testing.T) {
	for _, status := range []int{500, 404, 302} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Location", "/elsewhere")
			w.WriteHeader(status)
		}))
		result := New(time.Second, true).Send(context.Background(), request(server.URL))
		server.Close()
		if result.Succeeded() || result.StatusCode != status {
			t.Errorf("status %d: result = %+v, want a failure with that status", status, result)
		}
	}
}

func TestTimeout(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		<-release
	}))
	defer server.Close()
	defer close(release) // runs before server.Close (defers are LIFO), unblocking the handler

	result := New(100*time.Millisecond, true).Send(context.Background(), request(server.URL))
	if result.Succeeded() || result.StatusCode != 0 || result.Err.Error() != "timeout" {
		t.Fatalf("result = %+v, want a timeout without status", result)
	}
}

func TestSnippetIsCappedAndCleaned(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("\x00\xff" + strings.Repeat("x", 5000)))
	}))
	defer server.Close()

	result := New(time.Second, true).Send(context.Background(), request(server.URL))
	if !result.Succeeded() {
		t.Fatal(result.Err)
	}
	if strings.Contains(result.Snippet, "\x00") || len(result.Snippet) > snippetBytes+3 {
		t.Errorf("snippet not cleaned/capped: %d bytes", len(result.Snippet))
	}
}

func TestPrivateTargetsAreBlockedAtConnectTime(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("the request must never arrive")
	}))
	defer server.Close()

	// httptest listens on 127.0.0.1; also via a hostname, resolved by DNS before the check.
	for _, url := range []string{server.URL, strings.Replace(server.URL, "127.0.0.1", "localhost", 1)} {
		result := New(time.Second, false).Send(context.Background(), request(url))
		if result.Succeeded() || !strings.Contains(result.Err.Error(), "private address") {
			t.Errorf("%s: result = %+v, want blocked", url, result)
		}
	}
}

func TestIsPrivate(t *testing.T) {
	blocked := []string{"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254",
		"100.64.0.1", "0.0.0.0", "255.255.255.255", "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1", "224.0.0.1"}
	allowed := []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"}
	for _, ip := range blocked {
		if !isPrivate(netip.MustParseAddr(ip)) {
			t.Errorf("%s should be blocked", ip)
		}
	}
	for _, ip := range allowed {
		if isPrivate(netip.MustParseAddr(ip)) {
			t.Errorf("%s should be allowed", ip)
		}
	}
}
