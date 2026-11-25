// Package sender makes the signed HTTP POST of one delivery attempt (SPEC §5) and reports what
// happened. It knows nothing about the database: the worker decides what the result means.
package sender

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/lucianpantoja/webhook-delivery/worker/internal/signature"
)

const (
	userAgent = "webhook-delivery/0.1.0"
	// Only the start of the response is kept (attempts.response_body_snippet), for debugging.
	snippetBytes = 1024
	// The rest is read and thrown away up to this limit, so the connection can be reused;
	// a huge or endless body is cut off instead of tying up the worker.
	maxDrainBytes = 64 * 1024
)

// Request is one attempt to send.
type Request struct {
	URL       string
	Secret    string // whsec_…
	MessageID string // webhook-id: identical on every retry, the receiver's dedup key
	Body      []byte // message payload, sent and signed byte for byte
}

// Result is what one attempt produced. StatusCode is 0 when there was no response at all.
type Result struct {
	StatusCode int
	Err        error // nil only for a 2xx
	Duration   time.Duration
	Snippet    string
}

// Succeeded: any 2xx within the timeout (SPEC §4 rule 5).
func (r Result) Succeeded() bool { return r.Err == nil }

type Sender struct {
	client  *http.Client
	timeout time.Duration
	now     func() time.Time
}

// New builds a sender. allowPrivate=false installs the SSRF guard at connect time.
func New(timeout time.Duration, allowPrivate bool) *Sender {
	dialer := &net.Dialer{Timeout: timeout}
	if !allowPrivate {
		// Control runs after DNS resolution, right before connect(), with the real IP. This
		// closes the gap the API's URL check can't: a public hostname that resolves (or is
		// re-pointed later — DNS rebinding) to a private address.
		dialer.Control = func(_, address string, _ syscall.RawConn) error {
			return checkAddress(address)
		}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = dialer.DialContext
	transport.Proxy = nil // never route customer traffic through an environment proxy

	return &Sender{
		client: &http.Client{
			Transport: transport,
			// Redirects are not followed: a 3xx is a failed attempt (SPEC §4 rule 5). Following
			// them would also let an endpoint bounce us to a private address.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		timeout: timeout,
		now:     time.Now,
	}
}

// Send makes one attempt. The whole attempt — connect, send, wait for headers, read the body —
// must finish within the timeout; ctx can also cancel it (shutdown).
func (s *Sender) Send(ctx context.Context, req Request) Result {
	started := s.now()
	result := s.send(ctx, req, started)
	result.Duration = s.now().Sub(started)
	return result
}

func (s *Sender) send(ctx context.Context, req Request, started time.Time) Result {
	timestamp := started.Unix()
	sig, err := signature.Sign(req.Secret, req.MessageID, timestamp, req.Body)
	if err != nil {
		return Result{Err: err}
	}

	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, req.URL, bytes.NewReader(req.Body))
	if err != nil {
		return Result{Err: fmt.Errorf("invalid request: %w", err)}
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("User-Agent", userAgent)
	httpReq.Header.Set("webhook-id", req.MessageID)
	httpReq.Header.Set("webhook-timestamp", strconv.FormatInt(timestamp, 10))
	httpReq.Header.Set("webhook-signature", sig)

	resp, err := s.client.Do(httpReq)
	if err != nil {
		return Result{Err: describe(err)}
	}
	// Like a destructor/RAII in C++: runs when the function returns, whatever the path.
	defer func() { _ = resp.Body.Close() }()

	snippet := make([]byte, snippetBytes)
	n, readErr := io.ReadFull(resp.Body, snippet)
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxDrainBytes))

	result := Result{StatusCode: resp.StatusCode, Snippet: cleanSnippet(snippet[:n])}
	switch {
	case resp.StatusCode < 200 || resp.StatusCode > 299:
		result.Err = fmt.Errorf("HTTP %d", resp.StatusCode)
	case readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF):
		// 2xx, but the body could not be read in time: the receiver may not have finished.
		result.Err = describe(readErr)
	}
	return result
}

// describe turns transport errors into short messages for attempts.error and last_error.
func describe(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return errors.New("timeout")
	}
	// The guard's error arrives wrapped in *url.Error and *net.OpError; keep only its message.
	var blocked *blockedAddressError
	if errors.As(err, &blocked) {
		return blocked
	}
	return err
}

// PostgreSQL text can't hold NUL bytes or invalid UTF-8; responses can contain both.
func cleanSnippet(b []byte) string {
	s := string(b)
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "�")
	}
	return strings.ReplaceAll(s, "\x00", "")
}
