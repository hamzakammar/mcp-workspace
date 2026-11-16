package middleware

import (
	"context"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
)

// ClientIPKey is the context key under which ClientIP stores the derived client IP.
const ClientIPKey contextKey = "client_ip"

// trustedProxyHops returns TRUSTED_PROXY_HOPS (default 1): the number of
// trusted proxies (e.g. the AWS ALB) that append to X-Forwarded-For in front of
// the gateway. 0 means X-Forwarded-For is ignored entirely.
func trustedProxyHops() int {
	if v := strings.TrimSpace(os.Getenv("TRUSTED_PROXY_HOPS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return n
		}
	}
	return 1
}

// clientIPFromRequest derives the client IP without trusting client-controlled
// headers. Each trusted proxy appends its peer's address to X-Forwarded-For, so
// with N trusted hops the client is the Nth entry from the RIGHT; every entry
// further left may have been supplied by the client and is ignored.
// True-Client-IP / X-Real-IP are never consulted. If hops is 0, there is no
// X-Forwarded-For, it has fewer than N entries, or the entry is not an IP, the
// host part of RemoteAddr (port stripped) is used.
func clientIPFromRequest(r *http.Request) string {
	if hops := trustedProxyHops(); hops > 0 {
		var entries []string
		// Multiple header lines are equivalent to one comma-joined list.
		for _, line := range r.Header.Values("X-Forwarded-For") {
			for _, e := range strings.Split(line, ",") {
				entries = append(entries, strings.TrimSpace(e))
			}
		}
		if len(entries) >= hops {
			if parsed := net.ParseIP(entries[len(entries)-hops]); parsed != nil {
				return parsed.String()
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ClientIPOf returns the client IP stored by the ClientIP middleware, or
// derives it directly if the middleware has not run.
func ClientIPOf(r *http.Request) string {
	if ip, ok := r.Context().Value(ClientIPKey).(string); ok && ip != "" {
		return ip
	}
	return clientIPFromRequest(r)
}

// ClientIP is a replacement for chi's RealIP middleware. It stores the trusted
// client IP in the request context and sets r.RemoteAddr to it (as RealIP did)
// so downstream logging/proxying sees the same value.
func ClientIP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIPFromRequest(r)
		if ip != "" {
			r.RemoteAddr = ip
			r = r.WithContext(context.WithValue(r.Context(), ClientIPKey, ip))
		}
		next.ServeHTTP(w, r)
	})
}
