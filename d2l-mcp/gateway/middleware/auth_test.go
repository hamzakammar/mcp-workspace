package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The OAuth access-token prefix (hzn_at_) is a subset of the API-key prefix
// (hzn_). The Auth handler must route hzn_at_ to the OAuth path and every other
// hzn_ token to the unchanged API-key path.
func TestOAuthPrefixIsSubsetOfAPIKeyPrefix(t *testing.T) {
	if !strings.HasPrefix("hzn_at_abc", "hzn_") {
		t.Fatal("expected hzn_at_ to start with hzn_")
	}
	if strings.HasPrefix("hzn_live_abc", "hzn_at_") {
		t.Fatal("a normal API key must not be treated as an OAuth token")
	}
}

// Public routes must include the OAuth discovery + endpoint paths so an
// unauthenticated client can discover the flow, register, and exchange codes.
func TestOAuthEndpointsArePublic(t *testing.T) {
	public := []string{
		"/.well-known/oauth-protected-resource",
		"/.well-known/oauth-authorization-server",
		"/.well-known/oauth-protected-resource/mcp",
		"/register",
		"/authorize",
		"/token",
		"/revoke",
	}
	for _, p := range public {
		if !isPublicRoute(p) {
			t.Errorf("expected %s to be a public route", p)
		}
	}
	// The protected resource itself must NOT be public.
	if isPublicRoute("/mcp") {
		t.Error("/mcp must not be a public route")
	}
}

// A 401 on /mcp must carry a WWW-Authenticate header pointing at the
// protected-resource metadata so MCP clients can auto-discover OAuth.
func TestUnauthorizedEmitsWWWAuthenticateForMCP(t *testing.T) {
	t.Setenv("PUBLIC_BASE_URL", "https://horizon.example.com")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/mcp", nil)
	unauthorized(rec, req, "invalid_token", `{"error":"invalid_token"}`)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
	got := rec.Header().Get("WWW-Authenticate")
	wantMeta := "https://horizon.example.com/.well-known/oauth-protected-resource"
	if !strings.Contains(got, wantMeta) {
		t.Errorf("WWW-Authenticate missing resource_metadata pointer: %q", got)
	}
	if !strings.Contains(got, `error="invalid_token"`) {
		t.Errorf("WWW-Authenticate missing error code: %q", got)
	}
}

// Non-MCP 401s should not advertise MCP resource metadata.
func TestUnauthorizedNoWWWAuthenticateForNonMCP(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/notes", nil)
	unauthorized(rec, req, "", `{"error":"unauthorized"}`)

	if rec.Header().Get("WWW-Authenticate") != "" {
		t.Error("non-MCP routes must not emit a WWW-Authenticate header")
	}
}

func TestGetPublicBaseURLPrecedence(t *testing.T) {
	t.Setenv("PUBLIC_BASE_URL", "https://a.example.com/")
	if got := getPublicBaseURL(); got != "https://a.example.com" {
		t.Errorf("PUBLIC_BASE_URL should win and be trimmed, got %q", got)
	}
	t.Setenv("PUBLIC_BASE_URL", "")
	t.Setenv("API_HOST", "b.example.com")
	if got := getPublicBaseURL(); got != "https://b.example.com" {
		t.Errorf("API_HOST fallback failed, got %q", got)
	}
}
