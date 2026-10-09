package handlers

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/hamzakammar/horizon-gateway/middleware"
)

// NewProxy creates a reverse-proxy handler that forwards all requests to the
// Node worker defined by NODE_WORKER_URL (default: http://localhost:3000).
func NewProxy() http.HandlerFunc {
	workerURL := os.Getenv("NODE_WORKER_URL")
	if workerURL == "" {
		workerURL = "http://localhost:3000"
	}

	target, err := url.Parse(workerURL)
	if err != nil {
		panic(fmt.Sprintf("invalid NODE_WORKER_URL %q: %v", workerURL, err))
	}

	proxy := httputil.NewSingleHostReverseProxy(target)

	// Strip CORS headers from the upstream response so the gateway's own CORS
	// middleware is the single source of truth. Duplicate Allow-Origin headers
	// cause browsers to reject the response entirely.
	proxy.ModifyResponse = func(resp *http.Response) error {
		resp.Header.Del("Access-Control-Allow-Origin")
		resp.Header.Del("Access-Control-Allow-Methods")
		resp.Header.Del("Access-Control-Allow-Headers")
		resp.Header.Del("Access-Control-Allow-Credentials")
		resp.Header.Del("Access-Control-Expose-Headers")
		resp.Header.Del("Access-Control-Max-Age")
		return nil
	}

	// Customise error handling so proxy failures return proper JSON.
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		fmt.Printf("[PROXY] upstream error: %v\n", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":"upstream unavailable"}`))
	}

	return func(w http.ResponseWriter, r *http.Request) {
		// Never trust a client-supplied identity header — the backend treats it
		// as authenticated. It is re-set below only after gateway auth succeeds.
		r.Header.Del("X-User-Id")

		// Forward the original host so the Node app can build correct URLs.
		r.Header.Set("X-Forwarded-Host", r.Host)
		r.Header.Set("X-Forwarded-Proto", "https")

		// Inject authenticated user ID so Node can scope requests per-user.
		if userID, ok := r.Context().Value(middleware.UserIDKey).(string); ok && userID != "" {
			r.Header.Set("X-User-Id", userID)
		}

		proxy.ServeHTTP(w, r)
	}
}

// vncWebSocketPath is the only WebSocket endpoint the backend serves.
var vncWebSocketPath = regexp.MustCompile(`^/vnc/[0-9a-fA-F-]{36}/websockify/?$`)

// IsVNCWebSocket reports whether r is a noVNC stream upgrade.
func IsVNCWebSocket(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket") && vncWebSocketPath.MatchString(r.URL.Path)
}

// ProxyWebSocket tunnels a WebSocket upgrade request directly to the Node worker.
// chi's router doesn't handle WS upgrades, so we intercept before the router.
func ProxyWebSocket(nodeWorkerURL string, w http.ResponseWriter, r *http.Request) {
	target, err := url.Parse(nodeWorkerURL)
	if err != nil {
		http.Error(w, "bad gateway", http.StatusBadGateway)
		return
	}

	// Dial the Node worker TCP connection
	host := target.Host
	if !strings.Contains(host, ":") {
		host += ":80"
	}
	backendConn, err := net.DialTimeout("tcp", host, 5*time.Second)
	if err != nil {
		fmt.Printf("[WS PROXY] failed to connect to backend: %v\n", err)
		http.Error(w, "bad gateway", http.StatusBadGateway)
		return
	}
	defer backendConn.Close()

	// Hijack the client connection
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "websocket not supported", http.StatusInternalServerError)
		return
	}
	clientConn, clientBuf, err := hijacker.Hijack()
	if err != nil {
		fmt.Printf("[WS PROXY] hijack failed: %v\n", err)
		return
	}
	defer clientConn.Close()

	// A hijacked conn keeps the http.Server's Read/WriteTimeout deadlines
	// (60s/120s), which killed every VNC stream after a minute. The tunnel is
	// long-lived, so clear them.
	_ = clientConn.SetDeadline(time.Time{})

	// Forward the original HTTP upgrade request to backend
	r.Host = target.Host
	r.Header.Del("X-User-Id")
	r.Header.Set("X-Forwarded-Proto", "https")
	if err := r.Write(backendConn); err != nil {
		fmt.Printf("[WS PROXY] failed to write request: %v\n", err)
		return
	}

	// Bidirectional pipe. Read client bytes through the hijack buffer so
	// anything already read past the request headers isn't dropped.
	done := make(chan struct{}, 2)
	go func() { io.Copy(backendConn, clientBuf.Reader); done <- struct{}{} }()
	go func() { io.Copy(clientConn, backendConn); done <- struct{}{} }()
	<-done

	fmt.Printf("[WS PROXY] websocket session ended: %s\n", r.URL.Path)
}
