// Package signature signs outbound webhooks with the Standard Webhooks scheme (SPEC §5, ADR 0007):
//
//	webhook-signature: v1,<base64(HMAC-SHA256(secret_bytes, "{id}.{timestamp}.{body}"))>
//
// secret_bytes is the base64-decoded part of the endpoint secret after the "whsec_" prefix.
// The receiver recomputes the same HMAC over the raw body it got and compares in constant time
// (see tools/receiver/src/signature.ts).
package signature

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
)

const secretPrefix = "whsec_"

// ErrInvalidSecret means the endpoint secret is not "whsec_" + base64.
var ErrInvalidSecret = errors.New("signature: endpoint secret must be whsec_ followed by base64")

// Sign returns the value of the webhook-signature header.
// body must be the exact bytes that will be sent: re-serializing JSON would change them.
func Sign(secret, msgID string, timestamp int64, body []byte) (string, error) {
	encoded, ok := strings.CutPrefix(secret, secretPrefix)
	if !ok {
		return "", ErrInvalidSecret
	}
	key, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(key) == 0 {
		return "", ErrInvalidSecret
	}

	mac := hmac.New(sha256.New, key)
	// hash.Hash.Write never returns an error, so the results can be ignored.
	_, _ = mac.Write([]byte(msgID + "." + strconv.FormatInt(timestamp, 10) + "."))
	_, _ = mac.Write(body)
	return "v1," + base64.StdEncoding.EncodeToString(mac.Sum(nil)), nil
}
