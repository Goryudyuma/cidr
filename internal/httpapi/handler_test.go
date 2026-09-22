package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/goryudyuma/cidr/core"
)

func testHandler(t *testing.T, origins ...string) http.Handler {
	t.Helper()
	options := DefaultOptions()
	options.AllowedOrigins = origins
	return testHandlerWithOptions(t, options)
}

func testHandlerWithOptions(t *testing.T, options Options) http.Handler {
	t.Helper()
	h, err := NewHandler(options)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func request(h http.Handler, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	for key, value := range headers {
		r.Header.Set(key, value)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func assertError(t *testing.T, response *httptest.ResponseRecorder, status int, code, field string) *core.ValidationError {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status = %d, want %d: %s", response.Code, status, response.Body.String())
	}
	var result core.ErrorResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("invalid JSON error: %v", err)
	}
	if result.Error == nil || result.Error.Code != code || result.Error.Field != field || result.Error.Message == "" {
		t.Fatalf("error = %+v, want code=%q field=%q and a message", result.Error, code, field)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw) != 1 || raw["error"] == nil {
		t.Fatalf("error response must not include a partial result: %s", response.Body.String())
	}
	return result.Error
}

// These fixtures are also used by native core tests and the real-browser Wasm
// tests. Each HTTP result is compared with both the fixture and native Go.
func TestSharedFixtures(t *testing.T) {
	data, err := os.ReadFile("../../testdata/evaluate.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name    string                `json:"name"`
		Request json.RawMessage       `json:"request"`
		Result  *core.Result          `json:"result"`
		Error   *core.ValidationError `json:"error"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	if len(fixtures) == 0 {
		t.Fatal("shared fixtures must not be empty")
	}
	h := testHandler(t)
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			response := request(h, http.MethodPost, "/api/evaluate", string(fixture.Request), nil)
			native, nativeErr := core.EvaluateJSON(fixture.Request)
			if fixture.Error != nil {
				got := assertError(t, response, http.StatusBadRequest, fixture.Error.Code, fixture.Error.Field)
				var validation *core.ValidationError
				if !errors.As(nativeErr, &validation) || !reflect.DeepEqual(got, validation) {
					t.Fatalf("HTTP error %+v differs from native error %+v", got, nativeErr)
				}
				return
			}
			if nativeErr != nil || response.Code != http.StatusOK {
				t.Fatalf("native error=%v; HTTP status=%d body=%s", nativeErr, response.Code, response.Body.String())
			}
			var got core.Result
			if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if fixture.Result == nil || !reflect.DeepEqual(got, *fixture.Result) || !reflect.DeepEqual(got, native) {
				t.Fatalf("HTTP = %+v; fixture = %+v; native = %+v", got, fixture.Result, native)
			}
		})
	}
}

func TestJSONValidationParity(t *testing.T) {
	h := testHandler(t)
	for _, body := range []string{
		"", "{", "[]", "null", "{} {}",
		`{"unexpected":1}`,
		`{"initial":["192.0.2.1"],"initial":[]}`,
		`{"initial":[42]}`,
		`{"initial":["192.0.2.1"],"operations":[{"op":"invalid","value":"192.0.2.1"}]}`,
		`{"operations":[{"op":"remove","value":"::ffff:192.0.2.1"}]}`,
		`{"operations":[{"op":"add","value":"fe80::1%en0"}]}`,
	} {
		t.Run(body, func(t *testing.T) {
			_, err := core.EvaluateJSON([]byte(body))
			var want *core.ValidationError
			if !errors.As(err, &want) {
				t.Fatalf("test body must fail native validation: %v", err)
			}
			response := request(h, http.MethodPost, "/api/evaluate", body, nil)
			got := assertError(t, response, http.StatusBadRequest, want.Code, want.Field)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("HTTP error=%+v, native error=%+v", got, want)
			}
		})
	}
}

func TestBodyLimit(t *testing.T) {
	options := DefaultOptions()
	options.Limits.MaxBodyBytes = 2048
	h := testHandlerWithOptions(t, options)
	body := "{}" + strings.Repeat(" ", options.Limits.MaxBodyBytes-2)
	response := request(h, http.MethodPost, "/api/evaluate", body, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("body exactly at limit: status %d: %s", response.Code, response.Body.String())
	}
	body += " "
	response = request(h, http.MethodPost, "/api/evaluate", body, nil)
	got := assertError(t, response, http.StatusBadRequest, "body_too_large", "request")
	_, err := core.EvaluateJSONWithLimits(context.Background(), []byte(body), options.Limits)
	var want *core.ValidationError
	if !errors.As(err, &want) || !reflect.DeepEqual(got, want) {
		t.Fatalf("HTTP size error=%+v, native error=%+v", got, err)
	}
	// Unknown Content-Length (e.g. chunked HTTP) must obey the same limit.
	r := httptest.NewRequest(http.MethodPost, "/api/evaluate", strings.NewReader(body))
	r.ContentLength = -1
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	assertError(t, w, http.StatusBadRequest, "body_too_large", "request")
}

type brokenBody struct{}

func (brokenBody) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
func (brokenBody) Close() error             { return nil }

func TestBodyReadFailure(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/api/evaluate", nil)
	r.Body = brokenBody{}
	w := httptest.NewRecorder()
	testHandler(t).ServeHTTP(w, r)
	assertError(t, w, http.StatusBadRequest, "invalid_body", "body")
}

func TestRoutesAndMethods(t *testing.T) {
	h := testHandler(t)
	for _, path := range []string{"/", "/api/evaluate/", "/api/other"} {
		assertError(t, request(h, http.MethodPost, path, "{}", nil), http.StatusNotFound, "not_found", "path")
	}
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPut, http.MethodDelete, http.MethodOptions} {
		response := request(h, method, "/api/evaluate", "{}", nil)
		assertError(t, response, http.StatusMethodNotAllowed, "method_not_allowed", "method")
		if got := response.Header().Get("Allow"); got != "POST" {
			t.Fatalf("Allow=%q", got)
		}
	}
}

func TestDisabledCORSAndEmptyResponse(t *testing.T) {
	response := request(testHandler(t), http.MethodPost, "/api/evaluate", "{}", map[string]string{"Origin": "https://example.com"})
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d: %s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("CORS must be disabled by default, got %q", got)
	}
	if got := response.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type=%q", got)
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(body["cidrs"], []byte("[]")) || !bytes.Equal(body["ranges"], []byte("[]")) {
		t.Fatalf("empty arrays must not be null: %s", response.Body.String())
	}
}

func TestCORS(t *testing.T) {
	const origin = "https://ui.example.com:8443"
	h := testHandler(t, origin)
	response := request(h, http.MethodPost, "/api/evaluate", "{}", map[string]string{"Origin": origin})
	if response.Code != http.StatusOK || response.Header().Get("Access-Control-Allow-Origin") != origin ||
		response.Header().Get("Access-Control-Allow-Credentials") != "" || response.Header().Get("Vary") != "Origin" {
		t.Fatalf("unexpected CORS response: status=%d headers=%v", response.Code, response.Header())
	}
	for _, denied := range []string{"https://ui.example.com", "https://ui.example.com:8443.evil.com", "null"} {
		response := request(h, http.MethodPost, "/api/evaluate", "{}", map[string]string{"Origin": denied})
		assertError(t, response, http.StatusForbidden, "cors_origin_denied", "headers.Origin")
		if response.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("denied origin received CORS permission")
		}
	}
	if response := request(h, http.MethodPost, "/api/evaluate", "{}", nil); response.Code != http.StatusOK {
		t.Fatalf("non-browser clients should work with CORS configured: %s", response.Body.String())
	}
	response = request(h, http.MethodOptions, "/api/evaluate", "", map[string]string{
		"Origin": origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type",
	})
	if response.Code != http.StatusNoContent || response.Body.Len() != 0 ||
		response.Header().Get("Access-Control-Allow-Origin") != origin ||
		response.Header().Get("Access-Control-Allow-Methods") != "POST" ||
		response.Header().Get("Access-Control-Allow-Headers") != "Content-Type" {
		t.Fatalf("unexpected preflight response: status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
	for _, tc := range []struct {
		name, method, headers, field string
	}{
		{"missing-method", "", "", "headers.Access-Control-Request-Method"},
		{"wrong-method", "DELETE", "", "headers.Access-Control-Request-Method"},
		{"extra-header", "POST", "Content-Type, Authorization", "headers.Access-Control-Request-Headers"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := request(h, http.MethodOptions, "/api/evaluate", "", map[string]string{
				"Origin": origin, "Access-Control-Request-Method": tc.method, "Access-Control-Request-Headers": tc.headers,
			})
			assertError(t, response, http.StatusBadRequest, "invalid_preflight", tc.field)
		})
	}
	assertError(t, request(h, http.MethodOptions, "/api/evaluate", "", nil), http.StatusBadRequest, "invalid_preflight", "headers.Origin")
}

func TestCORSConfiguration(t *testing.T) {
	for _, origin := range []string{
		"", "*", "null", "file://example.com", "https://*.example.com", "https://example.com/",
		"https://example.com/path", "https://example.com?query", "https://example.com?", "https://example.com#fragment",
		"https://user:password@example.com", "https://", "https://example.com:invalid", " https://example.com", "https://example.com\r\nX-Test: foo",
	} {
		t.Run(origin, func(t *testing.T) {
			options := DefaultOptions()
			options.AllowedOrigins = []string{origin}
			if _, err := NewHandler(options); err == nil {
				t.Fatalf("accepted invalid origin %q", origin)
			}
		})
	}
	for _, origin := range []string{"https://example.com", "http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"} {
		options := DefaultOptions()
		options.AllowedOrigins = []string{origin}
		if _, err := NewHandler(options); err != nil {
			t.Fatalf("valid origin %q: %v", origin, err)
		}
	}
}

func TestConfiguredCountLimits(t *testing.T) {
	for _, tc := range []struct {
		name, body, code, field string
		configure               func(*Options)
	}{
		{
			name: "initial", body: `{"initial":["192.0.2.1","192.0.2.2"]}`, code: "input_limit", field: "initial",
			configure: func(options *Options) { options.Limits.MaxInitial = 1 },
		},
		{
			name: "operations", body: `{"operations":[{"op":"add","value":"192.0.2.1"},{"op":"add","value":"192.0.2.2"}]}`, code: "input_limit", field: "operations",
			configure: func(options *Options) { options.Limits.MaxOperations = 1 },
		},
		{
			name: "cidrs", body: `{"initial":["192.0.2.1","192.0.2.3"]}`, code: "output_limit", field: "cidrs",
			configure: func(options *Options) { options.Limits.MaxOutputCIDRs = 1 },
		},
		{
			name: "ranges", body: `{"initial":["192.0.2.1","192.0.2.3"]}`, code: "output_limit", field: "ranges",
			configure: func(options *Options) { options.Limits.MaxOutputRanges = 1 },
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			options := DefaultOptions()
			tc.configure(&options)
			response := request(testHandlerWithOptions(t, options), http.MethodPost, "/api/evaluate", tc.body, nil)
			got := assertError(t, response, http.StatusBadRequest, tc.code, tc.field)
			_, err := core.EvaluateJSONWithLimits(context.Background(), []byte(tc.body), options.Limits)
			var want *core.ValidationError
			if !errors.As(err, &want) || !reflect.DeepEqual(got, want) {
				t.Fatalf("HTTP error=%+v, native configured error=%+v", got, err)
			}
		})
	}
}

func TestLargeRequestsBeyondFormerLimits(t *testing.T) {
	req := core.Request{Initial: make([]string, 6000), Operations: make([]core.Operation, 6000)}
	for i := range req.Initial {
		req.Initial[i] = "192.0.2.0/24"
		req.Operations[i] = core.Operation{Op: "remove", Value: "192.0.2.0/25"}
	}
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	response := request(testHandler(t), http.MethodPost, "/api/evaluate", string(body), nil)
	if response.Code != http.StatusOK {
		t.Fatalf("large legitimate request: status=%d body=%s", response.Code, response.Body.String())
	}
	var result core.Result
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.CIDRs) != 1 || result.CIDRs[0] != "192.0.2.128/25" || result.AddressCount.IPv4 != "128" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestPositiveAPILimitsRequired(t *testing.T) {
	for _, tc := range []struct {
		name      string
		configure func(*Options, int)
	}{
		{"body", func(options *Options, value int) { options.Limits.MaxBodyBytes = value }},
		{"initial", func(options *Options, value int) { options.Limits.MaxInitial = value }},
		{"operations", func(options *Options, value int) { options.Limits.MaxOperations = value }},
		{"cidrs", func(options *Options, value int) { options.Limits.MaxOutputCIDRs = value }},
		{"ranges", func(options *Options, value int) { options.Limits.MaxOutputRanges = value }},
		{"timeout", func(options *Options, value int) { options.EvaluationTimeout = time.Duration(value) }},
		{"concurrency", func(options *Options, value int) { options.MaxConcurrent = value }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, value := range []int{0, -1} {
				options := DefaultOptions()
				tc.configure(&options, value)
				if _, err := NewHandler(options); err == nil {
					t.Fatalf("accepted %s=%d", tc.name, value)
				}
			}
		})
	}
}

func TestEvaluationDeadlineAndRequestCancellation(t *testing.T) {
	options := DefaultOptions()
	options.EvaluationTimeout = time.Nanosecond
	body := `{"initial":[` + strings.Repeat(`"192.0.2.1",`, 4999) + `"192.0.2.1"]}`
	response := request(testHandlerWithOptions(t, options), http.MethodPost, "/api/evaluate", body, nil)
	assertError(t, response, http.StatusServiceUnavailable, "evaluation_timeout", "request")

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest(http.MethodPost, "/api/evaluate", strings.NewReader("{}")).WithContext(ctx)
	w := httptest.NewRecorder()
	testHandler(t).ServeHTTP(w, r)
	assertError(t, w, http.StatusServiceUnavailable, "evaluation_timeout", "request")
}

type heldBody struct {
	reader  io.Reader
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (b *heldBody) Read(p []byte) (int, error) {
	b.once.Do(func() {
		close(b.entered)
		<-b.release
	})
	return b.reader.Read(p)
}

func (*heldBody) Close() error { return nil }

func TestOverloadRejectsWithoutQueueAndReleasesSlot(t *testing.T) {
	options := DefaultOptions()
	options.MaxConcurrent = 1
	h := testHandlerWithOptions(t, options)
	body := &heldBody{reader: strings.NewReader("{}"), entered: make(chan struct{}), release: make(chan struct{})}
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(body.release) }) }
	defer release()
	r := httptest.NewRequest(http.MethodPost, "/api/evaluate", nil)
	r.Body = body
	firstDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		firstDone <- w
	}()
	select {
	case <-body.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("first request never started reading")
	}
	secondDone := make(chan *httptest.ResponseRecorder, 1)
	go func() { secondDone <- request(h, http.MethodPost, "/api/evaluate", "{}", nil) }()
	select {
	case response := <-secondDone:
		assertError(t, response, http.StatusServiceUnavailable, "busy", "request")
		if response.Header().Get("Retry-After") == "" {
			t.Fatal("busy response must give a retry hint")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("overload queued instead of being rejected")
	}
	release()
	select {
	case response := <-firstDone:
		if response.Code != http.StatusOK {
			t.Fatalf("first request failed: %s", response.Body.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("first request did not complete after release")
	}
	if response := request(h, http.MethodPost, "/api/evaluate", "{}", nil); response.Code != http.StatusOK {
		t.Fatalf("slot was not released: %s", response.Body.String())
	}
	request(h, http.MethodPost, "/api/evaluate", "invalid JSON", nil)
	if response := request(h, http.MethodPost, "/api/evaluate", "{}", nil); response.Code != http.StatusOK {
		t.Fatalf("invalid request leaked a slot: %s", response.Body.String())
	}
}

func TestRealHTTP(t *testing.T) {
	server := httptest.NewServer(testHandler(t))
	defer server.Close()
	response, err := server.Client().Post(server.URL+"/api/evaluate", "application/json", strings.NewReader(`{"initial":["::/0","0.0.0.0/0"]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result core.Result
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || result.AddressCount.IPv4 != "4294967296" || result.AddressCount.IPv6 != "340282366920938463463374607431768211456" {
		t.Fatalf("status=%d result=%+v", response.StatusCode, result)
	}
}
