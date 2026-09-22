// Package httpapi exposes the shared IP-set evaluator over HTTP.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/goryudyuma/cidr/core"
)

// Options configures bounded HTTP evaluation and optional explicit-origin CORS.
// Use DefaultOptions as a starting point. All limits must be positive for HTTP.
// An empty AllowedOrigins list disables CORS; entries must be exact HTTP(S)
// origins, without paths, wildcards, user information, queries, or fragments.
type Options struct {
	AllowedOrigins    []string
	Limits            core.Limits
	EvaluationTimeout time.Duration
	MaxConcurrent     int
}

// DefaultOptions allows large evaluations while bounding a public API's resource
// usage. Browser/Wasm evaluation does not inherit these HTTP-specific limits.
func DefaultOptions() Options {
	return Options{
		Limits: core.Limits{
			MaxBodyBytes:    32 << 20,
			MaxInitial:      100_000,
			MaxOperations:   100_000,
			MaxOutputCIDRs:  1_000_000,
			MaxOutputRanges: 200_000,
		},
		EvaluationTimeout: 15 * time.Second,
		MaxConcurrent:     4,
	}
}

type handler struct {
	allowedOrigins    map[string]struct{}
	limits            core.Limits
	evaluationTimeout time.Duration
	slots             chan struct{}
}

// NewHandler constructs an evaluator handler without storing evaluation state.
func NewHandler(options Options) (http.Handler, error) {
	if options.Limits.MaxBodyBytes <= 0 || options.Limits.MaxInitial <= 0 || options.Limits.MaxOperations <= 0 ||
		options.Limits.MaxOutputCIDRs <= 0 || options.Limits.MaxOutputRanges <= 0 ||
		options.EvaluationTimeout <= 0 || options.MaxConcurrent <= 0 {
		return nil, errors.New("all API limits, evaluation timeout, and maximum concurrency must be positive")
	}
	h := &handler{
		allowedOrigins:    make(map[string]struct{}, len(options.AllowedOrigins)),
		limits:            options.Limits,
		evaluationTimeout: options.EvaluationTimeout,
		slots:             make(chan struct{}, options.MaxConcurrent),
	}
	for _, origin := range options.AllowedOrigins {
		u, err := url.Parse(origin)
		if err != nil || origin == "" || strings.TrimSpace(origin) != origin || strings.Contains(origin, "*") ||
			(u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.Hostname() == "" ||
			u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" ||
			origin != u.Scheme+"://"+u.Host {
			return nil, fmt.Errorf("invalid CORS origin %q: use an exact HTTP(S) origin without a path or wildcard", origin)
		}
		h.allowedOrigins[origin] = struct{}{}
	}
	return h, nil
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/evaluate" {
		writeError(w, http.StatusNotFound, "not_found", "The requested endpoint does not exist.", "path")
		return
	}

	origin := r.Header.Get("Origin")
	if len(h.allowedOrigins) != 0 {
		w.Header().Add("Vary", "Origin")
		if origin != "" {
			if _, allowed := h.allowedOrigins[origin]; !allowed {
				writeError(w, http.StatusForbidden, "cors_origin_denied", "This origin is not allowed.", "headers.Origin")
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
	}

	if r.Method == http.MethodOptions && len(h.allowedOrigins) != 0 {
		h.preflight(w, r, origin)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		if len(h.allowedOrigins) != 0 {
			w.Header().Set("Allow", "POST, OPTIONS")
		}
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Use POST /api/evaluate.", "method")
		return
	}

	// Acquire before reading: this bounds concurrent body buffers as well as
	// calculations and response writes. Excess requests never enter a queue.
	select {
	case h.slots <- struct{}{}:
		defer func() { <-h.slots }()
	default:
		w.Header().Set("Retry-After", "1")
		writeError(w, http.StatusServiceUnavailable, "busy", "All evaluation slots are busy. Retry later.", "request")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, int64(h.limits.MaxBodyBytes))
	defer r.Body.Close()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusBadRequest, "body_too_large", fmt.Sprintf("Request body must be at most %d bytes.", h.limits.MaxBodyBytes), "request")
		} else {
			writeError(w, http.StatusBadRequest, "invalid_body", "The request body could not be read.", "body")
		}
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.evaluationTimeout)
	defer cancel()
	result, err := core.EvaluateJSONWithLimits(ctx, body, h.limits)
	if err != nil {
		var validationError *core.ValidationError
		if errors.As(err, &validationError) {
			status := http.StatusBadRequest
			if validationError.Code == "evaluation_timeout" {
				status = http.StatusServiceUnavailable
			}
			writeJSON(w, status, core.ErrorResponse{Error: validationError})
		} else {
			writeError(w, http.StatusInternalServerError, "internal_error", "Evaluation failed.", "request")
		}
		return
	}
	if ctx.Err() != nil {
		writeError(w, http.StatusServiceUnavailable, "evaluation_timeout", "Evaluation was canceled or exceeded its time limit.", "request")
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *handler) preflight(w http.ResponseWriter, r *http.Request, origin string) {
	w.Header().Add("Vary", "Access-Control-Request-Method")
	w.Header().Add("Vary", "Access-Control-Request-Headers")
	if origin == "" {
		writeError(w, http.StatusBadRequest, "invalid_preflight", "CORS preflight requires an Origin header.", "headers.Origin")
		return
	}
	if r.Header.Get("Access-Control-Request-Method") != http.MethodPost {
		writeError(w, http.StatusBadRequest, "invalid_preflight", "CORS preflight only supports POST.", "headers.Access-Control-Request-Method")
		return
	}
	for _, requested := range strings.Split(r.Header.Get("Access-Control-Request-Headers"), ",") {
		name := strings.TrimSpace(requested)
		if name != "" && !strings.EqualFold(name, "Content-Type") {
			writeError(w, http.StatusBadRequest, "invalid_preflight", "Only the Content-Type request header is allowed.", "headers.Access-Control-Request-Headers")
			return
		}
	}
	w.Header().Set("Access-Control-Allow-Methods", http.MethodPost)
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.WriteHeader(http.StatusNoContent)
}

func writeError(w http.ResponseWriter, status int, code, message, field string) {
	writeJSON(w, status, core.ErrorResponse{Error: &core.ValidationError{Code: code, Message: message, Field: field}})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	// The concrete response types only contain JSON-supported values. A write
	// error here means that the client disconnected or its deadline expired.
	_ = json.NewEncoder(w).Encode(value)
}
