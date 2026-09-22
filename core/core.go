// Package core evaluates IP sets without depending on HTTP, JavaScript, or a UI.
package core

import (
	"context"
	"fmt"
	"math/big"
	"net/netip"
	"slices"
	"strings"

	"go4.org/netipx"
)

const MaxValueBytes = 128

// Limits applies optional resource limits. Zero means unlimited. Evaluate and
// EvaluateJSON use no count limits; network adapters should choose their own.
type Limits struct {
	MaxBodyBytes    int
	MaxInitial      int
	MaxOperations   int
	MaxOutputCIDRs  int
	MaxOutputRanges int
}

type Request struct {
	Initial    []string    `json:"initial,omitempty"`
	Operations []Operation `json:"operations,omitempty"`
}

type Operation struct {
	Op    string `json:"op"`
	Value string `json:"value"`
}

type Result struct {
	CIDRs        []string     `json:"cidrs"`
	Ranges       []Range      `json:"ranges"`
	AddressCount AddressCount `json:"addressCount"`
}

type Range struct {
	Family string `json:"family"`
	Start  string `json:"start"`
	End    string `json:"end"`
}

type AddressCount struct {
	IPv4 string `json:"ipv4"`
	IPv6 string `json:"ipv6"`
}

type ValidationError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Field   string `json:"field"`
}

func (e *ValidationError) Error() string {
	return e.Field + ": " + e.Message
}

type ErrorResponse struct {
	Error *ValidationError `json:"error"`
}

func invalid(code, field, message string) error {
	return &ValidationError{Code: code, Field: field, Message: message}
}

// Evaluate applies operations in order and returns an exact, minimal CIDR cover.
// On any failure it returns the zero Result; no partial set is exposed.
func Evaluate(req Request) (Result, error) {
	return EvaluateWithLimits(context.Background(), req, Limits{})
}

// EvaluateWithLimits supports server resource budgets without constraining the
// local WebAssembly caller. Cancellation returns no partial result.
func EvaluateWithLimits(ctx context.Context, req Request, limits Limits) (Result, error) {
	if err := checkContext(ctx); err != nil {
		return Result{}, err
	}
	if limits.MaxInitial > 0 && len(req.Initial) > limits.MaxInitial {
		return Result{}, invalid("input_limit", "initial", fmt.Sprintf("At most %d initial entries are allowed.", limits.MaxInitial))
	}
	if limits.MaxOperations > 0 && len(req.Operations) > limits.MaxOperations {
		return Result{}, invalid("input_limit", "operations", fmt.Sprintf("At most %d operations are allowed.", limits.MaxOperations))
	}

	// Validate everything before performing any set operations.
	initial := make([]netip.Prefix, len(req.Initial))
	for i, value := range req.Initial {
		if err := checkContext(ctx); err != nil {
			return Result{}, err
		}
		p, err := parseValue(value, fmt.Sprintf("initial[%d]", i))
		if err != nil {
			return Result{}, err
		}
		initial[i] = p
	}
	operations := make([]netip.Prefix, len(req.Operations))
	for i, op := range req.Operations {
		if err := checkContext(ctx); err != nil {
			return Result{}, err
		}
		if op.Op != "add" && op.Op != "remove" {
			return Result{}, invalid("invalid_operation", fmt.Sprintf("operations[%d].op", i), "Operation must be add or remove.")
		}
		p, err := parseValue(op.Value, fmt.Sprintf("operations[%d].value", i))
		if err != nil {
			return Result{}, err
		}
		operations[i] = p
	}

	var builder netipx.IPSetBuilder
	for _, p := range initial {
		if err := checkContext(ctx); err != nil {
			return Result{}, err
		}
		builder.AddPrefix(p)
	}
	for i, p := range operations {
		if err := checkContext(ctx); err != nil {
			return Result{}, err
		}
		if req.Operations[i].Op == "add" {
			// IPSetBuilder flushes pending removals before adding, preserving order.
			builder.AddPrefix(p)
		} else {
			builder.RemovePrefix(p)
		}
	}
	set, err := builder.IPSet()
	if err != nil {
		return Result{}, invalid("evaluation_error", "request", "Could not construct the IP set.")
	}
	return resultFromSet(ctx, set, limits)
}

func checkContext(ctx context.Context) error {
	if ctx.Err() != nil {
		return invalid("evaluation_timeout", "request", "Evaluation was canceled or exceeded its time limit.")
	}
	return nil
}

func parseValue(value, field string) (netip.Prefix, error) {
	if len(value) > MaxValueBytes {
		return netip.Prefix{}, invalid("input_limit", field, fmt.Sprintf("An IP or CIDR must be at most %d bytes.", MaxValueBytes))
	}
	if strings.Contains(value, "%") {
		return netip.Prefix{}, invalid("unsupported_address", field, "IPv6 zone identifiers are not supported.")
	}
	var p netip.Prefix
	var err error
	if strings.Contains(value, "/") {
		p, err = netip.ParsePrefix(value)
	} else {
		var addr netip.Addr
		addr, err = netip.ParseAddr(value)
		if err == nil {
			p = netip.PrefixFrom(addr, addr.BitLen())
		}
	}
	if err != nil || !p.IsValid() {
		return netip.Prefix{}, invalid("invalid_ip", field, "Expected a valid IPv4 or IPv6 address or CIDR.")
	}
	// Check before masking: a mapped address with /0 would otherwise become ::.
	if p.Addr().Is4In6() {
		return netip.Prefix{}, invalid("unsupported_address", field, "IPv4-mapped IPv6 addresses are not supported.")
	}
	return p.Masked(), nil
}

func resultFromSet(ctx context.Context, set *netipx.IPSet, limits Limits) (Result, error) {
	if err := checkContext(ctx); err != nil {
		return Result{}, err
	}
	ranges := set.Ranges()
	if limits.MaxOutputRanges > 0 && len(ranges) > limits.MaxOutputRanges {
		return Result{}, invalid("output_limit", "ranges", fmt.Sprintf("The result exceeds %d ranges.", limits.MaxOutputRanges))
	}
	// A single range needs at most 254 IPv6 prefixes. Check one range at a time
	// before materializing the full cover, which can be large after exclusions.
	prefixCount := 0
	for _, r := range ranges {
		if err := checkContext(ctx); err != nil {
			return Result{}, err
		}
		prefixCount += len(r.Prefixes())
		if limits.MaxOutputCIDRs > 0 && prefixCount > limits.MaxOutputCIDRs {
			return Result{}, invalid("output_limit", "cidrs", fmt.Sprintf("The result exceeds %d CIDRs.", limits.MaxOutputCIDRs))
		}
	}
	prefixes := set.Prefixes()
	slices.SortFunc(prefixes, func(a, b netip.Prefix) int { return a.Addr().Compare(b.Addr()) })
	slices.SortFunc(ranges, func(a, b netipx.IPRange) int { return a.From().Compare(b.From()) })
	result := Result{
		CIDRs:  make([]string, 0, len(prefixes)),
		Ranges: make([]Range, 0, len(ranges)),
	}
	for _, p := range prefixes {
		if err := checkContext(ctx); err != nil {
			return Result{}, err
		}
		result.CIDRs = append(result.CIDRs, p.String())
	}
	var ipv4, ipv6 big.Int
	one := big.NewInt(1)
	for _, r := range ranges {
		if err := checkContext(ctx); err != nil {
			return Result{}, err
		}
		family := "ipv6"
		total := &ipv6
		if r.From().Is4() {
			family, total = "ipv4", &ipv4
		}
		result.Ranges = append(result.Ranges, Range{Family: family, Start: r.From().String(), End: r.To().String()})
		start := new(big.Int).SetBytes(r.From().AsSlice())
		count := new(big.Int).SetBytes(r.To().AsSlice())
		count.Sub(count, start).Add(count, one)
		total.Add(total, count)
	}
	result.AddressCount = AddressCount{IPv4: ipv4.String(), IPv6: ipv6.String()}
	return result, nil
}
