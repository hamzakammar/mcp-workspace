package middleware

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type contextKey string

const UserIDKey contextKey = "user_id"

// publicRoutes are paths that do NOT require JWT authentication.
var publicRoutes = map[string]bool{
	"/health":               true,
	"/onboard":              true,
	"/admin/stats":          true,
	"/auth/signup":          true,
	"/auth/signin":          true,
	"/auth/refresh":         true,
	"/auth/notion/callback": true,
	"/auth/forgot-password": true,
	"/auth/reset-password":  true,
}

func isPublicRoute(path string) bool {
	if publicRoutes[path] {
		return true
	}
	if strings.HasPrefix(path, "/vnc/") || path == "/websockify" {
		return true
	}
	// Per-session status polling — the unguessable session UUID is the secret.
	if strings.HasPrefix(path, "/auth/d2l/status/") ||
		strings.HasPrefix(path, "/auth/outline/status/") ||
		strings.HasPrefix(path, "/auth/crowdmark/status/") {
		return true
	}
	// OAuth 2.1 discovery, dynamic client registration, and the authorization
	// server endpoints. These must be reachable without a token so a client can
	// discover the flow, register, log in, and exchange codes for tokens.
	if strings.HasPrefix(path, "/.well-known/") {
		return true
	}
	switch path {
	case "/register", "/authorize", "/token", "/revoke":
		return true
	}
	return false
}

// metricsAuthorized reports whether r may read /metrics: only when METRICS_TOKEN
// is configured and the request presents "Authorization: Bearer <METRICS_TOKEN>".
func metricsAuthorized(r *http.Request) bool {
	want := os.Getenv("METRICS_TOKEN")
	if want == "" {
		return false
	}
	got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// isMCPPath reports whether path is the MCP endpoint ("/mcp" or under "/mcp/"),
// the only resource OAuth access tokens are scoped to.
func isMCPPath(path string) bool {
	return path == "/mcp" || strings.HasPrefix(path, "/mcp/")
}

// getPublicBaseURL returns the externally-visible base URL of this deployment,
// used to build the WWW-Authenticate resource_metadata pointer.
func getPublicBaseURL() string {
	if u := os.Getenv("PUBLIC_BASE_URL"); u != "" {
		return strings.TrimRight(u, "/")
	}
	if h := os.Getenv("API_HOST"); h != "" {
		return "https://" + h
	}
	return "https://horizon.hamzaammar.ca"
}

// unauthorized writes a 401. For the protected MCP resource it also emits a
// spec-compliant WWW-Authenticate header pointing at the protected-resource
// metadata so an MCP client can auto-discover the OAuth flow (MCP auth spec).
func unauthorized(w http.ResponseWriter, r *http.Request, wwwErr, body string) {
	if r.URL.Path == "/mcp" {
		meta := getPublicBaseURL() + "/.well-known/oauth-protected-resource"
		val := fmt.Sprintf(`Bearer resource_metadata="%s"`, meta)
		if wwwErr != "" {
			val = fmt.Sprintf(`Bearer error="%s", resource_metadata="%s"`, wwwErr, meta)
		}
		w.Header().Set("WWW-Authenticate", val)
	}
	http.Error(w, body, http.StatusUnauthorized)
}

// resolveOAuthToken hashes an OAuth access token (hzn_at_...) and resolves it to
// a Horizon user_id via the oauth_access_tokens table, rejecting revoked or
// expired tokens. Mirrors resolveAPIKey but with expiry/revocation checks.
// It is a package variable so tests can stub the Supabase lookup.
var resolveOAuthToken = resolveOAuthTokenSupabase

func resolveOAuthTokenSupabase(accessToken string) (string, error) {
	hash := sha256.Sum256([]byte(accessToken))
	tokenHash := hex.EncodeToString(hash[:])

	sbURL := getSupabaseURL()
	sbKey := os.Getenv("SUPABASE_SERVICE_ROLE_KEY")
	if sbKey == "" {
		sbKey = getAnonKey()
	}
	if sbURL == "" || sbKey == "" {
		return "", fmt.Errorf("missing Supabase config for OAuth token validation")
	}

	restURL := fmt.Sprintf(
		"%s/rest/v1/oauth_access_tokens?token_hash=eq.%s&select=user_id,expires_at,revoked&limit=1",
		sbURL, tokenHash)
	req, err := http.NewRequest("GET", restURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("apikey", sbKey)
	req.Header.Set("Authorization", "Bearer "+sbKey)

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("oauth token lookup failed: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("oauth token lookup returned %d", resp.StatusCode)
	}

	var rows []struct {
		UserID    string `json:"user_id"`
		ExpiresAt string `json:"expires_at"`
		Revoked   bool   `json:"revoked"`
	}
	if err := json.Unmarshal(body, &rows); err != nil || len(rows) == 0 {
		return "", fmt.Errorf("oauth token not found")
	}
	row := rows[0]
	if row.Revoked {
		return "", fmt.Errorf("oauth token revoked")
	}
	exp, err := time.Parse(time.RFC3339, row.ExpiresAt)
	if err != nil {
		// Postgres may return a space-separated timestamp without timezone 'T'.
		exp, err = time.Parse("2006-01-02 15:04:05.999999-07", row.ExpiresAt)
		if err != nil {
			return "", fmt.Errorf("oauth token has unparseable expiry")
		}
	}
	if time.Now().After(exp) {
		return "", fmt.Errorf("oauth token expired")
	}
	if row.UserID == "" {
		return "", fmt.Errorf("oauth token missing user_id")
	}
	return row.UserID, nil
}

var httpClient = &http.Client{Timeout: 10 * time.Second}

type supabaseUser struct {
	ID string `json:"id"`
}

type supabaseSession struct {
	AccessToken  string       `json:"access_token"`
	RefreshToken string       `json:"refresh_token"`
	ExpiresAt    int64        `json:"expires_at"`
	User         supabaseUser `json:"user"`
}

// tokenCacheEntry holds the result of a successful refresh token exchange.
// Caching prevents single-use consumption: the same refresh token can be
// presented on multiple consecutive requests without hitting Supabase again.
//
// Entries live until the original session expiry, but are revalidated every
// tokenRevalidateInterval by exchanging the entry's LATEST refresh token, so a
// revoked/logged-out session stops working within that window. mu guards the
// mutable fields and serialises revalidation (refresh tokens are single-use).
type tokenCacheEntry struct {
	mu              sync.Mutex
	accessToken     string
	newRefreshToken string
	userID          string
	expiresAt       time.Time // immutable after creation
	validatedAt     time.Time
}

var (
	tokenCache   = make(map[string]*tokenCacheEntry)
	tokenCacheMu sync.RWMutex
)

func init() {
	// Periodically evict expired cache entries to prevent unbounded growth.
	go func() {
		for range time.Tick(10 * time.Minute) {
			now := time.Now()
			tokenCacheMu.Lock()
			for k, v := range tokenCache {
				if now.After(v.expiresAt) {
					delete(tokenCache, k)
				}
			}
			tokenCacheMu.Unlock()
		}
	}()
}

// tokenRevalidateInterval is how long a cached refresh-token exchange is
// trusted before it is revalidated against Supabase.
const tokenRevalidateInterval = 5 * time.Minute

// exchangeRefreshTokenFn is a package variable so tests can stub Supabase.
var exchangeRefreshTokenFn = exchangeRefreshToken

// errRefreshRejected marks a refresh exchange that Supabase explicitly
// rejected (4xx), as opposed to a transient/network failure.
var errRefreshRejected = errors.New("refresh token rejected")

func cacheTokenExchange(oldRefresh string, session *supabaseSession) {
	var expiresAt time.Time
	if session.ExpiresAt > 0 {
		// Use Supabase-reported expiry minus a 2-minute safety margin.
		expiresAt = time.Unix(session.ExpiresAt, 0).Add(-2 * time.Minute)
	} else {
		expiresAt = time.Now().Add(55 * time.Minute)
	}
	entry := &tokenCacheEntry{
		accessToken:     session.AccessToken,
		newRefreshToken: session.RefreshToken,
		userID:          session.User.ID,
		expiresAt:       expiresAt,
		validatedAt:     time.Now(),
	}
	tokenCacheMu.Lock()
	defer tokenCacheMu.Unlock()
	tokenCache[oldRefresh] = entry
	// Index by new refresh token too so seamless rotation works.
	if session.RefreshToken != "" && session.RefreshToken != oldRefresh {
		tokenCache[session.RefreshToken] = entry
	}
}

func lookupTokenCache(token string) *tokenCacheEntry {
	tokenCacheMu.RLock()
	defer tokenCacheMu.RUnlock()
	entry, ok := tokenCache[token]
	if !ok || time.Now().After(entry.expiresAt) {
		return nil
	}
	return entry
}

// dropTokenCacheEntry removes every key that points at e.
func dropTokenCacheEntry(e *tokenCacheEntry) {
	tokenCacheMu.Lock()
	defer tokenCacheMu.Unlock()
	for k, v := range tokenCache {
		if v == e {
			delete(tokenCache, k)
		}
	}
}

// cachedSession is a consistent snapshot of a tokenCacheEntry.
type cachedSession struct {
	accessToken     string
	newRefreshToken string
	userID          string
}

// revalidateTokenCacheEntry returns a snapshot of e, first re-exchanging its
// latest refresh token if it was last validated more than
// tokenRevalidateInterval ago. The new session is stored under the new refresh
// token as well (the old keys keep pointing at the same entry). If Supabase
// rejects the exchange (revoked/logged out) the entry is dropped and
// errRefreshRejected is returned; other errors leave the entry in place so a
// later request can retry.
func revalidateTokenCacheEntry(e *tokenCacheEntry) (cachedSession, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if time.Since(e.validatedAt) < tokenRevalidateInterval {
		return cachedSession{e.accessToken, e.newRefreshToken, e.userID}, nil
	}
	if e.newRefreshToken == "" {
		dropTokenCacheEntry(e)
		return cachedSession{}, errRefreshRejected
	}
	session, err := exchangeRefreshTokenFn(e.newRefreshToken)
	if err != nil {
		if errors.Is(err, errRefreshRejected) {
			dropTokenCacheEntry(e)
		}
		return cachedSession{}, err
	}
	if session.User.ID != e.userID {
		dropTokenCacheEntry(e)
		return cachedSession{}, errRefreshRejected
	}
	e.accessToken = session.AccessToken
	if session.RefreshToken != "" {
		e.newRefreshToken = session.RefreshToken
		tokenCacheMu.Lock()
		tokenCache[session.RefreshToken] = e
		tokenCacheMu.Unlock()
	}
	e.validatedAt = time.Now()
	return cachedSession{e.accessToken, e.newRefreshToken, e.userID}, nil
}

func getSupabaseURL() string { return os.Getenv("SUPABASE_URL") }
func getAnonKey() string {
	k := os.Getenv("SUPABASE_ANON_KEY")
	if k == "" {
		k = os.Getenv("SUPABASE_JWT_SECRET")
	}
	return k
}

// verifyAccessToken calls Supabase /auth/v1/user to validate an access token.
func verifyAccessToken(tokenStr string) (string, error) {
	req, err := http.NewRequest("GET", getSupabaseURL()+"/auth/v1/user", nil)
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+tokenStr)
	req.Header.Set("apikey", getAnonKey())

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("supabase request failed: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("supabase rejected token (status %d): %s", resp.StatusCode, string(body))
	}

	var user supabaseUser
	if err := json.Unmarshal(body, &user); err != nil || user.ID == "" {
		return "", fmt.Errorf("failed to parse user from response")
	}
	return user.ID, nil
}

// exchangeRefreshToken exchanges a refresh token for a fresh session.
func exchangeRefreshToken(refreshToken string) (*supabaseSession, error) {
	body, err := json.Marshal(map[string]string{"refresh_token": refreshToken})
	if err != nil {
		return nil, fmt.Errorf("failed to marshal refresh body: %w", err)
	}
	req, err := http.NewRequest("POST",
		getSupabaseURL()+"/auth/v1/token?grant_type=refresh_token",
		bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create refresh request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("apikey", getAnonKey())

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("refresh request failed: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		if resp.StatusCode >= 400 && resp.StatusCode < 500 {
			return nil, fmt.Errorf("%w (status %d): %s", errRefreshRejected, resp.StatusCode, string(respBody))
		}
		return nil, fmt.Errorf("refresh failed (status %d): %s", resp.StatusCode, string(respBody))
	}

	var session supabaseSession
	if err := json.Unmarshal(respBody, &session); err != nil || session.User.ID == "" {
		return nil, fmt.Errorf("failed to parse session from refresh response")
	}
	return &session, nil
}

// resolveAPIKey hashes the API key and looks it up in the api_keys table via Supabase REST API.
func resolveAPIKey(apiKey string) (string, error) {
	// SHA-256 hash the key
	hash := sha256.Sum256([]byte(apiKey))
	keyHash := hex.EncodeToString(hash[:])

	sbURL := getSupabaseURL()
	// Use service role key for api_keys lookup (bypasses RLS)
	sbKey := os.Getenv("SUPABASE_SERVICE_ROLE_KEY")
	if sbKey == "" {
		sbKey = getAnonKey()
	}
	if sbURL == "" || sbKey == "" {
		return "", fmt.Errorf("missing Supabase config for API key validation")
	}

	// Query api_keys table
	restURL := fmt.Sprintf("%s/rest/v1/api_keys?key_hash=eq.%s&revoked=eq.false&select=user_id&limit=1", sbURL, keyHash)
	req, err := http.NewRequest("GET", restURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("apikey", sbKey)
	req.Header.Set("Authorization", "Bearer "+sbKey)

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("api_keys lookup failed: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("api_keys lookup returned %d: %s", resp.StatusCode, string(body))
	}

	var rows []struct {
		UserID string `json:"user_id"`
	}
	if err := json.Unmarshal(body, &rows); err != nil || len(rows) == 0 {
		return "", fmt.Errorf("API key not found")
	}
	return rows[0].UserID, nil
}

// isLikelyRefreshToken returns true if the token looks like a Supabase refresh token
// (short alphanumeric string, not a JWT which always contains dots).
func isLikelyRefreshToken(token string) bool {
	return !strings.Contains(token, ".")
}

// Auth validates tokens by delegating to Supabase.
// Accepts both access tokens (JWT) and refresh tokens.
// If a refresh token is provided, it's exchanged for a fresh access token automatically.
func Auth(_ string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// The landing page is public, but only for GET/HEAD: an MCP client pointed at
			// the bare origin must still get the 401 + WWW-Authenticate discovery hint.
			isLanding := r.URL.Path == "/" && (r.Method == http.MethodGet || r.Method == http.MethodHead)

			// /metrics is not public: it requires METRICS_TOKEN as a bearer token.
			// Respond 404 otherwise so the endpoint is not advertised.
			if r.URL.Path == "/metrics" {
				if !metricsAuthorized(r) {
					http.NotFound(w, r)
					return
				}
				next.ServeHTTP(w, r)
				return
			}

			if isLanding || isPublicRoute(r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}

			// Dev/test bypass: SKIP_GATEWAY_AUTH=1 skips token validation.
			if os.Getenv("SKIP_GATEWAY_AUTH") == "1" {
				uid := r.Header.Get("X-Dev-User-Id")
				if uid == "" {
					uid = "dev-user"
				}
				fmt.Printf("[AUTH] SKIP_GATEWAY_AUTH=1, injecting userId=%s\n", uid)
				ctx := context.WithValue(r.Context(), UserIDKey, uid)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}

			apiKey := r.Header.Get("x-api-key")
			authHeader := r.Header.Get("Authorization")

			// ── OAuth 2.1 bearer access token (SECONDARY auth method) ──────────
			// Resolve OAuth access tokens (hzn_at_...) to a Horizon user. Checked
			// BEFORE the API-key branch because hzn_at_ is a subset of the hzn_
			// prefix. The existing API-key path below is left byte-for-byte intact.
			oauthTok := ""
			if authHeader != "" && strings.HasPrefix(authHeader, "Bearer hzn_at_") {
				oauthTok = strings.TrimPrefix(authHeader, "Bearer ")
			} else if strings.HasPrefix(apiKey, "hzn_at_") {
				oauthTok = apiKey
			}
			if oauthTok != "" {
				// OAuth access tokens are scoped to the MCP resource only.
				if !isMCPPath(r.URL.Path) {
					w.Header().Set("WWW-Authenticate", `Bearer error="insufficient_scope"`)
					http.Error(w, `{"error":"insufficient_scope"}`, http.StatusForbidden)
					return
				}
				uid, oauthErr := resolveOAuthToken(oauthTok)
				if oauthErr != nil {
					fmt.Printf("[AUTH] OAuth token validation failed: %v\n", oauthErr)
					unauthorized(w, r, "invalid_token", `{"error":"invalid_token"}`)
					return
				}
				fmt.Printf("[AUTH] OAuth token auth OK, userId=%s\n", uid)
				ctx := context.WithValue(r.Context(), UserIDKey, uid)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}

			// Check for API key auth (x-api-key header or Bearer hzn_ prefix)
			if apiKey == "" && authHeader != "" && strings.HasPrefix(authHeader, "Bearer hzn_") {
				apiKey = strings.TrimPrefix(authHeader, "Bearer ")
			}
			if apiKey != "" && strings.HasPrefix(apiKey, "hzn_") {
				// Resolve API key to userId via Supabase
				resolvedUserID, apiErr := resolveAPIKey(apiKey)
				if apiErr != nil {
					fmt.Printf("[AUTH] API key validation failed: %v\n", apiErr)
					http.Error(w, `{"error":"invalid API key"}`, http.StatusUnauthorized)
					return
				}
				fmt.Printf("[AUTH] API key auth OK, userId=%s\n", resolvedUserID)
				ctx := context.WithValue(r.Context(), UserIDKey, resolvedUserID)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}

			if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
				unauthorized(w, r, "", `{"error":"missing or invalid Authorization header"}`)
				return
			}
			tokenStr := strings.TrimPrefix(authHeader, "Bearer ")

			var userID string
			var err error

			if isLikelyRefreshToken(tokenStr) {
				// Refresh tokens are single-use at Supabase: exchanging the same token
				// twice invalidates it after the first call. We cache the exchange result
				// so subsequent requests with the same refresh token reuse the cached
				// access token instead of calling Supabase again.
				if entry := lookupTokenCache(tokenStr); entry != nil {
					cached, revalErr := revalidateTokenCacheEntry(entry)
					if revalErr != nil {
						fmt.Printf("[AUTH] Cached refresh token revalidation failed: %v\n", revalErr)
						if errors.Is(revalErr, errRefreshRejected) {
							unauthorized(w, r, "invalid_token", `{"error":"invalid or expired token"}`)
						} else {
							http.Error(w, `{"error":"auth upstream unavailable"}`, http.StatusServiceUnavailable)
						}
						return
					}
					fmt.Printf("[AUTH] Refresh token cache hit, userId=%s\n", cached.userID)
					r.Header.Set("Authorization", "Bearer "+cached.accessToken)
					// Advertise the rotated refresh token so clients can update their store.
					if cached.newRefreshToken != "" {
						w.Header().Set("X-New-Refresh-Token", cached.newRefreshToken)
					}
					ctx := context.WithValue(r.Context(), UserIDKey, cached.userID)
					next.ServeHTTP(w, r.WithContext(ctx))
					return
				}

				// Cache miss — exchange the refresh token (this consumes it at Supabase).
				fmt.Printf("[AUTH] Refresh token detected, exchanging for access token\n")
				session, refreshErr := exchangeRefreshTokenFn(tokenStr)
				if refreshErr != nil {
					fmt.Printf("[AUTH] Refresh token exchange failed: %v\n", refreshErr)
					unauthorized(w, r, "invalid_token", `{"error":"invalid or expired token"}`)
					return
				}
				cacheTokenExchange(tokenStr, session)
				userID = session.User.ID
				// Forward the fresh access token to the Node worker.
				r.Header.Set("Authorization", "Bearer "+session.AccessToken)
				// Advertise the new refresh token so clients can rotate without a second call.
				if session.RefreshToken != "" {
					w.Header().Set("X-New-Refresh-Token", session.RefreshToken)
				}
				fmt.Printf("[AUTH] Refresh exchange OK, userId=%s\n", userID)
			} else {
				// Access token (JWT) — verify directly with Supabase
				userID, err = verifyAccessToken(tokenStr)
				if err != nil {
					fmt.Printf("[AUTH] Access token validation failed: %v\n", err)
					unauthorized(w, r, "invalid_token", `{"error":"invalid or expired token"}`)
					return
				}
			}

			ctx := context.WithValue(r.Context(), UserIDKey, userID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
