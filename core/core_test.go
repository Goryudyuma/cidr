package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"math/rand"
	"net/netip"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"go4.org/netipx"
)

func TestSharedFixtures(t *testing.T) {
	data, err := os.ReadFile("../testdata/evaluate.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name    string           `json:"name"`
		Request json.RawMessage  `json:"request"`
		Result  *Result          `json:"result"`
		Error   *ValidationError `json:"error"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			got, err := EvaluateJSON(fixture.Request)
			if fixture.Error != nil {
				assertError(t, got, err, fixture.Error.Code, fixture.Error.Field)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if fixture.Result == nil || !reflect.DeepEqual(got, *fixture.Result) {
				t.Fatalf("got %#v; want %#v", got, fixture.Result)
			}
			var req Request
			if err := json.Unmarshal(fixture.Request, &req); err != nil {
				t.Fatal(err)
			}
			native, err := Evaluate(req)
			if err != nil || !reflect.DeepEqual(native, got) {
				t.Fatalf("Evaluate = %#v, %v; EvaluateJSON = %#v", native, err, got)
			}
		})
	}
}

func assertError(t *testing.T, got Result, err error, code, field string) {
	t.Helper()
	var validation *ValidationError
	if !errors.As(err, &validation) {
		t.Fatalf("expected ValidationError, got %v", err)
	}
	if validation.Code != code || validation.Field != field || validation.Message == "" {
		t.Fatalf("got %#v; want code=%s field=%s and a message", validation, code, field)
	}
	if !reflect.DeepEqual(got, Result{}) {
		t.Fatalf("error exposed partial result: %#v", got)
	}
}

func TestInputLimits(t *testing.T) {
	limits := Limits{MaxInitial: 4, MaxOperations: 4, MaxBodyBytes: 1024}
	t.Run("initial", func(t *testing.T) {
		req := Request{Initial: []string{"::1", "::1", "::1", "::1"}}
		if _, err := EvaluateWithLimits(context.Background(), req, limits); err != nil {
			t.Fatal(err)
		}
		req.Initial = append(req.Initial, "::2")
		got, err := EvaluateWithLimits(context.Background(), req, limits)
		assertError(t, got, err, "input_limit", "initial")
		data, _ := json.Marshal(req)
		got, err = EvaluateJSONWithLimits(context.Background(), data, limits)
		assertError(t, got, err, "input_limit", "initial")
	})
	t.Run("operations", func(t *testing.T) {
		req := Request{Operations: make([]Operation, limits.MaxOperations)}
		for i := range req.Operations {
			req.Operations[i] = Operation{Op: "remove", Value: "::1"}
		}
		if _, err := EvaluateWithLimits(context.Background(), req, limits); err != nil {
			t.Fatal(err)
		}
		req.Operations = append(req.Operations, Operation{Op: "add", Value: "::2"})
		got, err := EvaluateWithLimits(context.Background(), req, limits)
		assertError(t, got, err, "input_limit", "operations")
		data, _ := json.Marshal(req)
		got, err = EvaluateJSONWithLimits(context.Background(), data, limits)
		assertError(t, got, err, "input_limit", "operations")
	})
	t.Run("value", func(t *testing.T) {
		got, err := Evaluate(Request{Initial: []string{strings.Repeat("a", MaxValueBytes+1)}})
		assertError(t, got, err, "input_limit", "initial[0]")
	})
	t.Run("body", func(t *testing.T) {
		data := []byte("{}" + strings.Repeat(" ", limits.MaxBodyBytes-2))
		if _, err := EvaluateJSONWithLimits(context.Background(), data, limits); err != nil {
			t.Fatal(err)
		}
		got, err := EvaluateJSONWithLimits(context.Background(), append(data, ' '), limits)
		assertError(t, got, err, "body_too_large", "request")
	})
}

func TestDefaultEvaluationHasNoCountLimit(t *testing.T) {
	req := Request{Initial: make([]string, 12000), Operations: make([]Operation, 12000)}
	for i := range req.Initial {
		req.Initial[i] = "2001:db8::/32"
	}
	for i := range req.Operations {
		req.Operations[i] = Operation{Op: "remove", Value: "::1"}
	}
	expected := Result{CIDRs: []string{"2001:db8::/32"}, Ranges: []Range{{Family: "ipv6", Start: "2001:db8::", End: "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"}}, AddressCount: AddressCount{IPv4: "0", IPv6: "79228162514264337593543950336"}}
	got, err := Evaluate(req)
	if err != nil || !reflect.DeepEqual(got, expected) {
		t.Fatalf("Evaluate: %#v, %v", got, err)
	}
	data, _ := json.Marshal(req)
	// Cross the former body cap as well, with valid JSON whitespace.
	data = append(data, []byte(strings.Repeat(" ", 1<<20))...)
	got, err = EvaluateJSON(data)
	if err != nil || !reflect.DeepEqual(got, expected) {
		t.Fatalf("EvaluateJSON: %#v, %v", got, err)
	}
}

func TestOutputLimit(t *testing.T) {
	req := Request{Initial: []string{"::/0"}, Operations: []Operation{{Op: "remove", Value: "2001:db8::1"}}}
	got, err := EvaluateWithLimits(context.Background(), req, Limits{MaxOutputCIDRs: 100})
	assertError(t, got, err, "output_limit", "cidrs")
	got, err = Evaluate(req)
	if err != nil || len(got.CIDRs) != 128 {
		t.Fatalf("unlimited result: %d prefixes, %v", len(got.CIDRs), err)
	}
	_, err = EvaluateWithLimits(context.Background(), req, Limits{MaxOutputCIDRs: 128})
	if err != nil {
		t.Fatalf("limit itself must work: %v", err)
	}
}

func TestDefaultEvaluationHasNoOutputLimit(t *testing.T) {
	req := Request{Initial: []string{"::/0"}}
	for i := range 256 {
		req.Operations = append(req.Operations, Operation{Op: "remove", Value: fmt.Sprintf("2001:%x::1", i)})
	}
	got, err := Evaluate(req)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.CIDRs) <= 16384 {
		t.Fatalf("expected this case to exceed the former output cap, got %d", len(got.CIDRs))
	}
	if got.AddressCount.IPv6 != "340282366920938463463374607431768211200" {
		t.Fatalf("incorrect full IPv6 count minus 256: %s", got.AddressCount.IPv6)
	}
}

func TestOutputRangeLimit(t *testing.T) {
	req := Request{Initial: []string{"192.0.2.1", "192.0.2.3", "192.0.2.5"}}
	got, err := EvaluateWithLimits(context.Background(), req, Limits{MaxOutputRanges: 2})
	assertError(t, got, err, "output_limit", "ranges")
	if _, err := EvaluateWithLimits(context.Background(), req, Limits{MaxOutputRanges: 3}); err != nil {
		t.Fatal(err)
	}
}

func TestCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got, err := EvaluateWithLimits(ctx, Request{}, Limits{})
	assertError(t, got, err, "evaluation_timeout", "request")
	got, err = EvaluateJSONWithLimits(ctx, []byte(`{}`), Limits{})
	assertError(t, got, err, "evaluation_timeout", "request")
	var builder netipx.IPSetBuilder
	set, _ := builder.IPSet()
	got, err = resultFromSet(ctx, set, Limits{})
	assertError(t, got, err, "evaluation_timeout", "request")

	req := Request{Initial: []string{"::/0"}}
	for i := range 30000 {
		req.Operations = append(req.Operations, Operation{Op: "remove", Value: fmt.Sprintf("2001:%x::1", i)}, Operation{Op: "add", Value: "::1"})
	}
	ctx, cancel = context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	start := time.Now()
	got, err = EvaluateWithLimits(ctx, req, Limits{})
	assertError(t, got, err, "evaluation_timeout", "request")
	if time.Since(start) > 2*time.Second {
		t.Fatal("cancellation did not bound alternating operation work")
	}
}

func TestJSONValidation(t *testing.T) {
	tests := []struct{ input, code, field string }{
		{"", "invalid_json", "request"},
		{"[]", "invalid_json", "request"},
		{"{", "invalid_json", "request"},
		{"{} {}", "invalid_json", "request"},
		{"{} trailing", "invalid_json", "request"},
		{`{"initial":[]`, "invalid_json", "request"},
		{`{"initial":[}`, "invalid_json", "initial"},
		{`{"initial":[],"initial":[]}`, "duplicate_field", "initial"},
		{`{"operations":[{"op":"add","op":"remove","value":"::"}]}`, "duplicate_field", "operations[0].op"},
		{`{"operations":null}`, "invalid_json", "operations"},
		{`{"operations":{}}`, "invalid_json", "operations"},
		{`{"operations":[{}]}`, "invalid_json", "operations[0].op"},
		{`{"operations":[{"op":null,"value":"::"}]}`, "invalid_json", "operations[0].op"},
		{`{"operations":[{"op":"add","value":null}]}`, "invalid_json", "operations[0].value"},
		{`{"operations":[{"op":"add","value":12}]}`, "invalid_json", "operations[0].value"},
		{`{"initial":[null]}`, "invalid_json", "initial[0]"},
		{`{"Initial":[]}`, "unknown_field", "Initial"},
		{`{"":0}`, "unknown_field", `request[""]`},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got, err := EvaluateJSON([]byte(tt.input))
			assertError(t, got, err, tt.code, tt.field)
		})
	}
}

func TestMalformedValues(t *testing.T) {
	for _, value := range []string{"", "192.0.2.1 ", " 192.0.2.1", "192.0.2.1/33", "1.2.3", "01.2.3.4", "[::1]", "::/129", "::/abc", "::/-1"} {
		t.Run(value, func(t *testing.T) {
			got, err := Evaluate(Request{Initial: []string{value}})
			assertError(t, got, err, "invalid_ip", "initial[0]")
		})
	}
}

func TestUniverseBoundaryRemovals(t *testing.T) {
	for _, tt := range []struct {
		cidr, first, last string
		bits              int
	}{
		{"0.0.0.0/0", "0.0.0.0", "255.255.255.255", 32},
		{"::/0", "::", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", 128},
	} {
		t.Run(tt.cidr, func(t *testing.T) {
			result, err := Evaluate(Request{Initial: []string{tt.cidr}, Operations: []Operation{{Op: "remove", Value: tt.first}, {Op: "remove", Value: tt.last}}})
			if err != nil {
				t.Fatal(err)
			}
			if len(result.Ranges) != 1 || result.Ranges[0].Start != netip.MustParseAddr(tt.first).Next().String() || result.Ranges[0].End != netip.MustParseAddr(tt.last).Prev().String() {
				t.Fatalf("incorrect remaining range: %#v", result.Ranges)
			}
			want := new(big.Int).Lsh(big.NewInt(1), uint(tt.bits))
			want.Sub(want, big.NewInt(2))
			count := result.AddressCount.IPv6
			if tt.bits == 32 {
				count = result.AddressCount.IPv4
			}
			if count != want.String() {
				t.Fatalf("count = %s; want %s", count, want)
			}
			if len(result.CIDRs) != 2*(tt.bits-1) {
				t.Fatalf("CIDR count = %d; want %d", len(result.CIDRs), 2*(tt.bits-1))
			}
		})
	}
}

func TestEmptyArraysAreNotNull(t *testing.T) {
	result, err := Evaluate(Request{})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(result)
	if string(data) != `{"cidrs":[],"ranges":[],"addressCount":{"ipv4":"0","ipv6":"0"}}` {
		t.Fatalf("unexpected empty JSON: %s", data)
	}
}

// Only tests enumerate addresses, and only within two 256-address universes.
func TestRandomizedAgainstBoundedReference(t *testing.T) {
	rng := rand.New(rand.NewSource(20260922))
	for trial := range 300 {
		req := Request{}
		var membership [2][256]bool
		applyRandom := func(initial bool) {
			family, offset, hostBits := rng.Intn(2), rng.Intn(256), rng.Intn(9)
			length := 1 << hostBits
			start := offset & ^(length - 1)
			addr := testAddr(family, offset)
			value := addr.String()
			if hostBits != 0 || rng.Intn(2) == 0 {
				// Deliberately retain host bits in a subset of prefix inputs.
				value = netip.PrefixFrom(addr, addr.BitLen()-hostBits).String()
			}
			add := initial || rng.Intn(2) == 0
			if initial {
				req.Initial = append(req.Initial, value)
			} else {
				op := "remove"
				if add {
					op = "add"
				}
				req.Operations = append(req.Operations, Operation{Op: op, Value: value})
			}
			for i := start; i < start+length; i++ {
				membership[family][i] = add
			}
		}
		for range rng.Intn(16) {
			applyRandom(true)
		}
		for range rng.Intn(120) {
			applyRandom(false)
		}
		got, err := Evaluate(req)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		want := referenceResult(membership)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("trial %d\nrequest: %#v\ngot: %#v\nwant: %#v", trial, req, got, want)
		}
		verifyExactCover(t, got, membership)
	}
}

func testAddr(family, offset int) netip.Addr {
	if family == 0 {
		return netip.AddrFrom4([4]byte{192, 0, 2, byte(offset)})
	}
	return netip.AddrFrom16([16]byte{0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, byte(offset)})
}

// Recursively select a whole dyadic block only when every address is present.
// This independent reference produces the unique minimum cover in our universe.
func referenceResult(membership [2][256]bool) Result {
	result := Result{CIDRs: []string{}, Ranges: []Range{}}
	var counts [2]int
	for family := range 2 {
		var visit func(start, length, hostBits int)
		visit = func(start, length, hostBits int) {
			full := true
			for i := start; i < start+length; i++ {
				full = full && membership[family][i]
			}
			if full {
				addr := testAddr(family, start)
				result.CIDRs = append(result.CIDRs, netip.PrefixFrom(addr, addr.BitLen()-hostBits).String())
			} else if length > 1 {
				visit(start, length/2, hostBits-1)
				visit(start+length/2, length/2, hostBits-1)
			}
		}
		visit(0, 256, 8)
		familyName := []string{"ipv4", "ipv6"}[family]
		for i := 0; i < 256; i++ {
			if !membership[family][i] {
				continue
			}
			start := i
			for i < 255 && membership[family][i+1] {
				i++
			}
			counts[family] += i - start + 1
			result.Ranges = append(result.Ranges, Range{Family: familyName, Start: testAddr(family, start).String(), End: testAddr(family, i).String()})
		}
	}
	result.AddressCount = AddressCount{IPv4: fmt.Sprint(counts[0]), IPv6: fmt.Sprint(counts[1])}
	return result
}

func verifyExactCover(t *testing.T, result Result, membership [2][256]bool) {
	t.Helper()
	var seen [2][256]bool
	prefixes := make([]netip.Prefix, len(result.CIDRs))
	for i, cidr := range result.CIDRs {
		p := netip.MustParsePrefix(cidr)
		prefixes[i] = p
		family := 1
		if p.Addr().Is4() {
			family = 0
		}
		if p.Bits() < p.Addr().BitLen()-8 || !netip.PrefixFrom(testAddr(family, 0), p.Addr().BitLen()-8).Contains(p.Addr()) {
			t.Fatalf("prefix escaped bounded universe: %s", p)
		}
		for offset := range 256 {
			if p.Contains(testAddr(family, offset)) {
				if seen[family][offset] || !membership[family][offset] {
					t.Fatalf("overlap or unwanted address: %s", testAddr(family, offset))
				}
				seen[family][offset] = true
			}
		}
	}
	if seen != membership {
		t.Fatal("CIDRs omitted addresses")
	}
	for _, p := range prefixes {
		if p.Bits() == 0 {
			continue
		}
		parent := netip.PrefixFrom(p.Addr(), p.Bits()-1).Masked()
		for _, q := range prefixes {
			if p != q && p.Bits() == q.Bits() && parent.Contains(q.Addr()) {
				t.Fatalf("mergeable siblings %s and %s", p, q)
			}
		}
	}
	if !slices.IsSortedFunc(prefixes, func(a, b netip.Prefix) int { return a.Addr().Compare(b.Addr()) }) {
		t.Fatal("CIDRs are not sorted")
	}
}

func FuzzEvaluateJSON(f *testing.F) {
	for _, seed := range []string{`{}`, `{"initial":["::/0","0.0.0.0/0"]}`, `{"operations":[{"op":"remove","value":"::ffff:1.2.3.4"}]}`, `null`, `{"initial":null}`, `{"operations":[{`, `{"initial":["192.0.2.1"]}`} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		got, err := EvaluateJSON(data)
		if err != nil {
			var validation *ValidationError
			if !errors.As(err, &validation) || validation.Code == "" || validation.Field == "" || validation.Message == "" {
				t.Fatalf("unstructured error: %v", err)
			}
			if !reflect.DeepEqual(got, Result{}) {
				t.Fatal("partial result on failure")
			}
			return
		}
		if got.CIDRs == nil || got.Ranges == nil || got.AddressCount.IPv4 == "" || got.AddressCount.IPv6 == "" {
			t.Fatalf("incomplete result: %#v", got)
		}
	})
}
