package middleware

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// RateLimiter stores per-user request counts in a sliding window.
type RateLimiter struct {
	mu       sync.Mutex
	requests map[string][]time.Time
	limit    int
	window   time.Duration
}

// NewRateLimiter creates a rate limiter with the given request limit per window.
func NewRateLimiter(limit int, window time.Duration) *RateLimiter {
	rl := &RateLimiter{
		requests: make(map[string][]time.Time),
		limit:    limit,
		window:   window,
	}
	// Background goroutine to clean up stale entries
	go func() {
		ticker := time.NewTicker(window)
		defer ticker.Stop()
		for range ticker.C {
			rl.cleanup()
		}
	}()
	return rl
}

func (rl *RateLimiter) cleanup() {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	for key, times := range rl.requests {
		valid := times[:0]
		for _, t := range times {
			if now.Sub(t) <= rl.window {
				valid = append(valid, t)
			}
		}
		if len(valid) == 0 {
			delete(rl.requests, key)
		} else {
			rl.requests[key] = valid
		}
	}
}

// Allow returns true if the given key is within the rate limit.
func (rl *RateLimiter) Allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	times := rl.requests[key]

	// Prune requests outside the window
	valid := times[:0]
	for _, t := range times {
		if now.Sub(t) <= rl.window {
			valid = append(valid, t)
		}
	}

	if len(valid) >= rl.limit {
		rl.requests[key] = valid
		return false
	}

	rl.requests[key] = append(valid, now)
	return true
}

// RateLimit returns middleware that applies per-user rate limiting.
// Users are identified by the UserIDKey in the request context (set by Auth middleware).
// Falls back to IP address for unauthenticated requests.
func RateLimit(limiter *RateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// The noVNC client is ~70 static modules per page load; counting them
			// would exhaust a shared campus NAT IP's budget and break VNC.
			if strings.HasPrefix(r.URL.Path, "/vnc/assets/") {
				next.ServeHTTP(w, r)
				return
			}

			// Identify the requester
			key := ""
			if uid, ok := r.Context().Value(UserIDKey).(string); ok && uid != "" {
				key = "user:" + uid
			} else {
				key = "ip:" + r.RemoteAddr
			}

			if !limiter.Allow(key) {
				fmt.Printf("[RATELIMIT] Rate limit exceeded for %s\n", key)
				w.Header().Set("Retry-After", "60")
				http.Error(w, `{"error":"rate limit exceeded"}`, http.StatusTooManyRequests)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
