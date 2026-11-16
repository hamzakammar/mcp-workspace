package middleware

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
}

// ── /metrics protection ─────────────────────────────────────────────────────

func TestMetricsNotPublic(t *testing.T) {
	if isPublicRoute("/metrics") {
		t.Fatal("/metrics must not be a public route")
	}
}

func TestMetricsRequiresToken(t *testing.T) {
	h := Auth("")(okHandler())
	cases := []struct {
		name, env, auth string
		want            int
	}{
		{"no env configured", "", "Bearer anything", http.StatusNotFound},
		{"no header", "s3cret", "", http.StatusNotFound},
		{"wrong token", "s3cret", "Bearer nope", http.StatusNotFound},
		{"correct token", "s3cret", "Bearer s3cret", http.StatusOK},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("METRICS_TOKEN", c.env)
			req := httptest.NewRequest("GET", "/metrics", nil)
			if c.auth != "" {
				req.Header.Set("Authorization", c.auth)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != c.want {
				t.Fatalf("got %d, want %d", rec.Code, c.want)
			}
		})
	}
}

func TestRouteLabelUsesPatternNotRawPath(t *testing.T) {
	var got string
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req)
			got = routeLabel(req)
		})
	})
	r.HandleFunc("/*", func(w http.ResponseWriter, req *http.Request) {})
	uuidPath := "/vnc/123e4567-e89b-12d3-a456-426614174000/index.html"
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", uuidPath, nil))
	if got != "/*" {
		t.Fatalf("expected route pattern /*, got %q", got)
	}
	if strings.Contains(got, "123e4567") {
		t.Fatal("route label leaked raw path")
	}

	// Without a chi route context, fall back to a constant.
	if l := routeLabel(httptest.NewRequest("GET", uuidPath, nil)); l != unmatchedRoute {
		t.Fatalf("expected %q fallback, got %q", unmatchedRoute, l)
	}
}

// ── OAuth access-token scoping ──────────────────────────────────────────────

func TestOAuthTokenRestrictedToMCP(t *testing.T) {
	t.Setenv("SKIP_GATEWAY_AUTH", "")
	calls := 0
	orig := resolveOAuthToken
	resolveOAuthToken = func(string) (string, error) { calls++; return "user-1", nil }
	t.Cleanup(func() { resolveOAuthToken = orig })

	var gotUID string
	h := Auth("")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUID, _ = r.Context().Value(UserIDKey).(string)
		w.WriteHeader(http.StatusOK)
	}))

	for _, p := range []string{"/mcp", "/mcp/", "/mcp/sse"} {
		gotUID = ""
		req := httptest.NewRequest("POST", p, nil)
		req.Header.Set("Authorization", "Bearer hzn_at_abc")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || gotUID != "user-1" {
			t.Errorf("%s: expected 200 with user-1, got %d uid=%q", p, rec.Code, gotUID)
		}
	}

	before := calls
	for _, p := range []string{"/api/notes", "/mcpx", "/auth/d2l/start"} {
		for _, viaAPIKey := range []bool{false, true} {
			req := httptest.NewRequest("GET", p, nil)
			if viaAPIKey {
				req.Header.Set("x-api-key", "hzn_at_abc")
			} else {
				req.Header.Set("Authorization", "Bearer hzn_at_abc")
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusForbidden {
				t.Errorf("%s: expected 403, got %d", p, rec.Code)
			}
			if got := rec.Header().Get("WWW-Authenticate"); got != `Bearer error="insufficient_scope"` {
				t.Errorf("%s: bad WWW-Authenticate %q", p, got)
			}
		}
	}
	if calls != before {
		t.Error("OAuth token should not be resolved for out-of-scope paths")
	}
}

// ── Client IP / rate limiting ───────────────────────────────────────────────

func TestClientIPRightMostXFF(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.0.0.5:4321"
	req.Header.Set("X-Forwarded-For", "1.1.1.1, 2.2.2.2, 203.0.113.9")
	req.Header.Set("X-Real-IP", "9.9.9.9")
	req.Header.Set("True-Client-IP", "8.8.8.8")
	if got := clientIPFromRequest(req); got != "203.0.113.9" {
		t.Fatalf("got %q", got)
	}

	// Multiple header lines: right-most entry of the last line wins.
	req2 := httptest.NewRequest("GET", "/", nil)
	req2.Header.Add("X-Forwarded-For", "1.1.1.1")
	req2.Header.Add("X-Forwarded-For", "5.5.5.5, 203.0.113.10")
	if got := clientIPFromRequest(req2); got != "203.0.113.10" {
		t.Fatalf("got %q", got)
	}
}

func TestClientIPStripsPort(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "198.51.100.7:55555"
	if got := clientIPFromRequest(req); got != "198.51.100.7" {
		t.Fatalf("got %q", got)
	}
	req.RemoteAddr = "[2001:db8::1]:443"
	if got := clientIPFromRequest(req); got != "2001:db8::1" {
		t.Fatalf("got %q", got)
	}
}

func TestRateLimitSpoofedXFFSharesBucket(t *testing.T) {
	limiter := NewRateLimiter(1, time.Minute)
	h := ClientIP(RateLimit(limiter)(okHandler()))

	do := func(xff, remote string) int {
		req := httptest.NewRequest("GET", "/api/x", nil)
		req.RemoteAddr = remote
		if xff != "" {
			req.Header.Set("X-Forwarded-For", xff)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	if c := do("6.6.6.6, 203.0.113.1", "10.0.0.1:1111"); c != http.StatusOK {
		t.Fatalf("first request: %d", c)
	}
	if c := do("7.7.7.7, 203.0.113.1", "10.0.0.2:2222"); c != http.StatusTooManyRequests {
		t.Fatalf("spoofed left-most XFF should share bucket, got %d", c)
	}

	// Without XFF, different ports from the same host share one bucket.
	limiter2 := NewRateLimiter(1, time.Minute)
	h = ClientIP(RateLimit(limiter2)(okHandler()))
	if c := do("", "198.51.100.1:1000"); c != http.StatusOK {
		t.Fatalf("first: %d", c)
	}
	if c := do("", "198.51.100.1:2000"); c != http.StatusTooManyRequests {
		t.Fatalf("port should be stripped from key, got %d", c)
	}
}

func TestTrustedProxyHops(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.0.0.9:1234"
	req.Header.Set("X-Forwarded-For", "6.6.6.6, 203.0.113.5, 198.51.100.20")

	t.Setenv("TRUSTED_PROXY_HOPS", "2")
	if got := clientIPFromRequest(req); got != "203.0.113.5" {
		t.Fatalf("hops=2: got %q", got)
	}
	t.Setenv("TRUSTED_PROXY_HOPS", "0")
	if got := clientIPFromRequest(req); got != "10.0.0.9" {
		t.Fatalf("hops=0 must ignore XFF: got %q", got)
	}
	t.Setenv("TRUSTED_PROXY_HOPS", "5")
	if got := clientIPFromRequest(req); got != "10.0.0.9" {
		t.Fatalf("fewer entries than hops must fall back to RemoteAddr: got %q", got)
	}
	t.Setenv("TRUSTED_PROXY_HOPS", "garbage")
	if got := clientIPFromRequest(req); got != "198.51.100.20" {
		t.Fatalf("invalid value should default to 1: got %q", got)
	}
}

func TestAuthEndpointRateLimit(t *testing.T) {
	strict := NewRateLimiter(2, time.Minute)
	loose := NewRateLimiter(3, time.Minute)
	h := ClientIP(AuthEndpointRateLimit(strict, loose)(okHandler()))
	do := func(method, path string) int {
		req := httptest.NewRequest(method, path, nil)
		req.RemoteAddr = "198.51.100.2:1"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	// Strict: POST /authorize.
	do("POST", "/authorize")
	do("POST", "/authorize")
	if c := do("POST", "/authorize"); c != http.StatusTooManyRequests {
		t.Fatalf("expected 429 on third POST /authorize, got %d", c)
	}
	// GET /authorize (login page render) and OPTIONS are not limited.
	for i := 0; i < 5; i++ {
		if c := do("GET", "/authorize"); c != http.StatusOK {
			t.Fatalf("GET /authorize must not be strictly limited, got %d", c)
		}
		if c := do("OPTIONS", "/auth/signin"); c != http.StatusOK {
			t.Fatalf("OPTIONS must be exempt, got %d", c)
		}
	}
	// /metrics is strict.
	do("GET", "/metrics")
	do("GET", "/metrics")
	if c := do("GET", "/metrics"); c != http.StatusTooManyRequests {
		t.Fatalf("expected /metrics to be limited, got %d", c)
	}
	// /register uses the loose limiter.
	for i := 0; i < 3; i++ {
		if c := do("POST", "/register"); c != http.StatusOK {
			t.Fatalf("register %d: %d", i, c)
		}
	}
	if c := do("POST", "/register"); c != http.StatusTooManyRequests {
		t.Fatalf("expected loose limit on /register, got %d", c)
	}
	// /token is left to the general limiter.
	for i := 0; i < 10; i++ {
		if c := do("POST", "/token"); c != http.StatusOK {
			t.Fatalf("/token must not be limited here, got %d", c)
		}
	}
}

func TestInvalidOAuthTokenOnMCP(t *testing.T) {
	t.Setenv("SKIP_GATEWAY_AUTH", "")
	t.Setenv("PUBLIC_BASE_URL", "https://horizon.example.com")
	orig := resolveOAuthToken
	resolveOAuthToken = func(string) (string, error) { return "", errors.New("oauth token revoked") }
	t.Cleanup(func() { resolveOAuthToken = orig })

	req := httptest.NewRequest("POST", "/mcp", nil)
	req.Header.Set("Authorization", "Bearer hzn_at_bad")
	rec := httptest.NewRecorder()
	Auth("")(okHandler()).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
	got := rec.Header().Get("WWW-Authenticate")
	if !strings.Contains(got, `error="invalid_token"`) || !strings.Contains(got, "resource_metadata=") {
		t.Fatalf("bad WWW-Authenticate: %q", got)
	}
}

// ── Refresh-token cache revalidation ────────────────────────────────────────

func stubExchange(t *testing.T, fn func(string) (*supabaseSession, error)) {
	t.Helper()
	orig := exchangeRefreshTokenFn
	exchangeRefreshTokenFn = fn
	t.Cleanup(func() { exchangeRefreshTokenFn = orig })
}

func resetTokenCache(t *testing.T) {
	t.Helper()
	clear := func() {
		tokenCacheMu.Lock()
		for k := range tokenCache {
			delete(tokenCache, k)
		}
		tokenCacheMu.Unlock()
	}
	clear()
	t.Cleanup(clear)
}

func ageEntry(t *testing.T, key string) {
	t.Helper()
	e := lookupTokenCache(key)
	if e == nil {
		t.Fatalf("no cache entry for %s", key)
	}
	e.mu.Lock()
	e.validatedAt = time.Now().Add(-tokenRevalidateInterval - time.Second)
	e.mu.Unlock()
}

func doRefresh(h http.Handler, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("GET", "/api/notes", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestRefreshCacheRevalidation(t *testing.T) {
	t.Setenv("SKIP_GATEWAY_AUTH", "")
	resetTokenCache(t)

	var exchanged []string
	revoked := false
	stubExchange(t, func(rt string) (*supabaseSession, error) {
		exchanged = append(exchanged, rt)
		if revoked {
			return nil, fmt.Errorf("%w (status 400)", errRefreshRejected)
		}
		n := len(exchanged)
		return &supabaseSession{
			AccessToken:  fmt.Sprintf("at%d", n),
			RefreshToken: fmt.Sprintf("rt%d", n),
			ExpiresAt:    time.Now().Add(time.Hour).Unix(),
			User:         supabaseUser{ID: "u1"},
		}, nil
	})

	var fwdAuth string
	h := Auth("")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fwdAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))

	// First use: cache miss, exchange rt0 -> (at1, rt1).
	rec := doRefresh(h, "rt0")
	if rec.Code != 200 || fwdAuth != "Bearer at1" || len(exchanged) != 1 {
		t.Fatalf("first: code=%d fwd=%q exchanged=%v", rec.Code, fwdAuth, exchanged)
	}
	// Fresh cache hit: no exchange.
	rec = doRefresh(h, "rt0")
	if rec.Code != 200 || len(exchanged) != 1 {
		t.Fatalf("cache hit should not exchange: %v", exchanged)
	}

	// After the revalidation interval, the LATEST refresh token (rt1) is
	// exchanged, not the presented rt0, and the client keeps working.
	ageEntry(t, "rt0")
	rec = doRefresh(h, "rt0")
	if rec.Code != 200 || fwdAuth != "Bearer at2" {
		t.Fatalf("revalidated: code=%d fwd=%q", rec.Code, fwdAuth)
	}
	if exchanged[len(exchanged)-1] != "rt1" {
		t.Fatalf("expected revalidation to exchange rt1, got %v", exchanged)
	}
	if got := rec.Header().Get("X-New-Refresh-Token"); got != "rt2" {
		t.Fatalf("expected rotated token rt2, got %q", got)
	}
	// New key is indexed too.
	if lookupTokenCache("rt2") == nil || lookupTokenCache("rt2") != lookupTokenCache("rt0") {
		t.Fatal("rt2 should map to the same entry as rt0")
	}

	// Revoked: revalidation fails -> 401 and entry dropped under every key.
	revoked = true
	ageEntry(t, "rt0")
	rec = doRefresh(h, "rt0")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 after revocation, got %d", rec.Code)
	}
	for _, k := range []string{"rt0", "rt1", "rt2"} {
		if lookupTokenCache(k) != nil {
			t.Fatalf("entry for %s should be dropped", k)
		}
	}
}

func TestRefreshCacheTransientFailureKeepsEntry(t *testing.T) {
	t.Setenv("SKIP_GATEWAY_AUTH", "")
	resetTokenCache(t)
	cacheTokenExchange("rtA", &supabaseSession{
		AccessToken: "atA", RefreshToken: "rtB",
		ExpiresAt: time.Now().Add(time.Hour).Unix(), User: supabaseUser{ID: "u"},
	})
	stubExchange(t, func(string) (*supabaseSession, error) { return nil, errors.New("network down") })
	ageEntry(t, "rtA")
	rec := doRefresh(Auth("")(okHandler()), "rtA")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 on transient failure, got %d", rec.Code)
	}
	if lookupTokenCache("rtA") == nil {
		t.Fatal("transient failure must not drop the entry")
	}
}

func TestTokenCacheKeepsOriginalExpiry(t *testing.T) {
	resetTokenCache(t)
	cacheTokenExchange("rtX", &supabaseSession{
		AccessToken: "at", RefreshToken: "rtY",
		ExpiresAt: time.Now().Add(time.Hour).Unix(), User: supabaseUser{ID: "u"},
	})
	e := lookupTokenCache("rtX")
	if e == nil || time.Until(e.expiresAt) < 50*time.Minute {
		t.Fatal("entry should keep the session expiry (minus margin), not a 5m cap")
	}
}
