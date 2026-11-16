package main

import (
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/hamzakammar/horizon-gateway/handlers"
	"github.com/hamzakammar/horizon-gateway/metrics"
	"github.com/hamzakammar/horizon-gateway/middleware"
)

func main() {
	// Register all Prometheus metrics.
	metrics.Register()

	// Configuration from environment.
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	jwksURL := os.Getenv("SUPABASE_JWKS_URL")
	if jwksURL == "" {
		jwksURL = "https://qialmumlcezeqvyyhjlu.supabase.co/auth/v1/.well-known/jwks.json"
	}

	handler := newHandler(jwksURL)

	addr := ":" + port
	fmt.Printf("[GATEWAY] Horizon MCP Gateway starting on %s\n", addr)
	fmt.Printf("[GATEWAY] Proxying to NODE_WORKER_URL: %s\n", nodeWorkerURL())
	fmt.Printf("[GATEWAY] JWKS URL: %s\n", jwksURL)

	srv := &http.Server{
		Addr:         addr,
		Handler:      handler,
		ReadTimeout:  60 * time.Second,
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  180 * time.Second,
	}

	if err := srv.ListenAndServe(); err != nil {
		fmt.Fprintf(os.Stderr, "[GATEWAY] Fatal: %v\n", err)
		os.Exit(1)
	}
}

// newHandler builds the gateway's full HTTP handler: the chi router with its
// middleware chain, wrapped so noVNC WebSocket upgrades bypass chi.
func newHandler(jwksURL string) http.Handler {
	// Rate limiter: 300 requests per minute per user/IP.
	limiter := middleware.NewRateLimiter(300, time.Minute)
	// Per-IP limiters applied before Auth: strict for password checks (POST
	// /authorize, POST /auth/signin) and /metrics, loose for /register.
	strictAuthLimiter := middleware.NewRateLimiter(30, time.Minute)
	looseAuthLimiter := middleware.NewRateLimiter(300, time.Minute)

	r := chi.NewRouter()

	// ── Global middleware ────────────────────────────────────────────────────
	r.Use(chimiddleware.Recoverer)
	r.Use(middleware.ClientIP)                                                   // Client IP from X-Forwarded-For (TRUSTED_PROXY_HOPS) or RemoteAddr host
	r.Use(middleware.CORS)                                                       // CORS headers + OPTIONS preflight (must run before Auth)
	r.Use(middleware.Metrics)                                                    // Prometheus instrumentation (all routes)
	r.Use(middleware.AuthEndpointRateLimit(strictAuthLimiter, looseAuthLimiter)) // Per-IP limits on credential endpoints
	r.Use(middleware.Auth(jwksURL))                                              // JWT verification (skips public routes internally)
	r.Use(middleware.RateLimit(limiter))                                         // Per-user rate limiting

	// ── Public routes (no auth required) ────────────────────────────────────
	r.Get("/health", handlers.Health)

	// /metrics requires METRICS_TOKEN as a bearer token (enforced in Auth).
	r.Handle("/metrics", promhttp.Handler())

	// ── Proxy all other routes to Node worker ────────────────────────────────
	proxy := handlers.NewProxy()
	r.HandleFunc("/*", proxy)

	// Forward WebSocket upgrades directly to Node worker (for noVNC)
	// chi router doesn't handle WS upgrades — must attach to the raw server
	nodeURL := nodeWorkerURL()
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if handlers.IsVNCWebSocket(req) {
			handlers.ProxyWebSocket(nodeURL, w, req)
			return
		}
		r.ServeHTTP(w, req)
	})
}

func nodeWorkerURL() string {
	if u := os.Getenv("NODE_WORKER_URL"); u != "" {
		return u
	}
	return "http://localhost:3000"
}
