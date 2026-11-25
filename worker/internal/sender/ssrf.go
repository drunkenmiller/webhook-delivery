package sender

import (
	"fmt"
	"net/netip"
)

// The worker-side SSRF guard (SPEC §10). Same ranges as the API's url-safety.ts, but checked on
// the IP the connection is really about to use.

type blockedAddressError struct{ addr netip.Addr }

func (e *blockedAddressError) Error() string {
	return fmt.Sprintf("refused to connect to private address %s", e.addr)
}

// Not covered by netip's IsPrivate/IsLoopback/… helpers.
var extraBlocked = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),     // "this network"
	netip.MustParsePrefix("100.64.0.0/10"), // carrier-grade NAT
	netip.MustParsePrefix("192.0.0.0/24"),  // IETF protocol assignments
	netip.MustParsePrefix("198.18.0.0/15"), // benchmarking
	netip.MustParsePrefix("240.0.0.0/4"),   // reserved (includes 255.255.255.255)
	netip.MustParsePrefix("64:ff9b::/96"),  // NAT64: could reach IPv4 private space
	netip.MustParsePrefix("2001:db8::/32"), // documentation
}

// checkAddress receives "ip:port" from the dialer, after DNS resolution.
func checkAddress(address string) error {
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return fmt.Errorf("unexpected dial address %q: %w", address, err)
	}
	if isPrivate(ap.Addr()) {
		return &blockedAddressError{addr: ap.Addr()}
	}
	return nil
}

func isPrivate(addr netip.Addr) bool {
	addr = addr.Unmap() // ::ffff:127.0.0.1 is 127.0.0.1
	if addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast() ||
		addr.IsLinkLocalMulticast() || addr.IsInterfaceLocalMulticast() || addr.IsMulticast() ||
		addr.IsUnspecified() {
		return true
	}
	for _, prefix := range extraBlocked {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}
