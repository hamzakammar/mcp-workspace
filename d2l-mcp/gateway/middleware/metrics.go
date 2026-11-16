package middleware

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	gometrics "github.com/hamzakammar/horizon-gateway/metrics"
)

// unmatchedRoute is the label used when no chi route pattern is available.
const unmatchedRoute = "unmatched"

// routeLabel returns a low-cardinality route label: the chi route pattern
// (e.g. "/health", "/*"), never the raw path, which can contain per-session
// UUIDs (VNC/onboarding) that would leak via /metrics. Must be called AFTER
// next.ServeHTTP, since chi fills the pattern during routing.
func routeLabel(r *http.Request) string {
	if rctx := chi.RouteContext(r.Context()); rctx != nil {
		if p := rctx.RoutePattern(); p != "" {
			return p
		}
	}
	return unmatchedRoute
}

// responseWriter wraps http.ResponseWriter to capture the status code.
type responseWriter struct {
	http.ResponseWriter
	status int
}

func newResponseWriter(w http.ResponseWriter) *responseWriter {
	return &responseWriter{ResponseWriter: w, status: http.StatusOK}
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.status = code
	rw.ResponseWriter.WriteHeader(code)
}

// Flush lets httputil.ReverseProxy stream (MCP uses text/event-stream). Without
// it the proxy buffers the whole upstream body before sending anything.
func (rw *responseWriter) Flush() {
	if f, ok := rw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (rw *responseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := rw.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, fmt.Errorf("underlying ResponseWriter does not support hijacking")
}

func (rw *responseWriter) Unwrap() http.ResponseWriter { return rw.ResponseWriter }

// Metrics returns middleware that instruments every request with Prometheus metrics.
func Metrics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := newResponseWriter(w)

		next.ServeHTTP(rw, r)

		duration := time.Since(start).Seconds()
		status := strconv.Itoa(rw.status)
		route := routeLabel(r)
		method := r.Method

		labels := []string{method, route, status}
		gometrics.RequestDuration.WithLabelValues(labels...).Observe(duration)
		gometrics.RequestsTotal.WithLabelValues(labels...).Inc()

		fmt.Printf("[%s] %s %s %d (%.3fs)\n", time.Now().Format(time.RFC3339), method, r.URL.Path, rw.status, duration)
	})
}
