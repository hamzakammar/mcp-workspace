package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/hamzakammar/horizon-gateway/metrics"
)

var registerOnce sync.Once

// newTestGateway wires the real middleware chain (newHandler) in front of a
// fake Node worker.
func newTestGateway(t *testing.T) http.Handler {
	t.Helper()
	registerOnce.Do(metrics.Register)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(upstream.Close)
	t.Setenv("NODE_WORKER_URL", upstream.URL)
	t.Setenv("SKIP_GATEWAY_AUTH", "")
	return newHandler("")
}

func serve(h http.Handler, method, path string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	req.RemoteAddr = "10.0.0.1:5555"
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestGatewayMetricsGatedAndNoRawPaths(t *testing.T) {
	h := newTestGateway(t)
	t.Setenv("METRICS_TOKEN", "mtok")

	// A public VNC path containing a session UUID goes through the proxy.
	uuid := "123e4567-e89b-12d3-a456-426614174000"
	if rec := serve(h, "GET", "/vnc/"+uuid+"/vnc.html", nil); rec.Code != http.StatusOK {
		t.Fatalf("vnc proxy: %d", rec.Code)
	}

	if rec := serve(h, "GET", "/metrics", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("/metrics without token: %d", rec.Code)
	}
	rec := serve(h, "GET", "/metrics", map[string]string{"Authorization": "Bearer mtok"})
	if rec.Code != http.StatusOK {
		t.Fatalf("/metrics with token: %d", rec.Code)
	}
	body, _ := io.ReadAll(rec.Body)
	if strings.Contains(string(body), uuid) {
		t.Fatal("/metrics leaked a session UUID")
	}
	if !strings.Contains(string(body), `route="/*"`) {
		t.Fatal("expected proxied requests to be labelled by route pattern")
	}
}

func TestGatewayAuthEndpointLimits(t *testing.T) {
	h := newTestGateway(t)

	// OPTIONS preflights are never limited.
	for i := 0; i < 40; i++ {
		if rec := serve(h, "OPTIONS", "/authorize", nil); rec.Code != http.StatusNoContent {
			t.Fatalf("OPTIONS %d: %d", i, rec.Code)
		}
	}
	// /token is not subject to the strict 30/min limit.
	for i := 0; i < 40; i++ {
		if rec := serve(h, "POST", "/token", nil); rec.Code == http.StatusTooManyRequests {
			t.Fatalf("/token limited at request %d", i)
		}
	}
	// POST /authorize: 30/min per client IP. Spoofed left-most XFF entries
	// still resolve to the same (right-most, ALB-appended) client IP.
	for i := 0; i < 30; i++ {
		hdr := map[string]string{"X-Forwarded-For": strings.Repeat("9", i%3+1) + ".1.1.1, 203.0.113.50"}
		if rec := serve(h, "POST", "/authorize", hdr); rec.Code == http.StatusTooManyRequests {
			t.Fatalf("limited too early at %d", i)
		}
	}
	rec := serve(h, "POST", "/authorize", map[string]string{"X-Forwarded-For": "8.8.8.8, 203.0.113.50"})
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 on 31st POST /authorize, got %d", rec.Code)
	}
	// A different client IP is unaffected.
	rec = serve(h, "POST", "/authorize", map[string]string{"X-Forwarded-For": "203.0.113.51"})
	if rec.Code == http.StatusTooManyRequests {
		t.Fatal("different client IP should have its own bucket")
	}
}

func TestGatewayOAuthTokenScope(t *testing.T) {
	h := newTestGateway(t)
	rec := serve(h, "GET", "/api/notes", map[string]string{"Authorization": "Bearer hzn_at_x"})
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Header().Get("WWW-Authenticate"), "insufficient_scope") {
		t.Fatalf("expected 403 insufficient_scope, got %d %q", rec.Code, rec.Header().Get("WWW-Authenticate"))
	}
}
