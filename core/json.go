package core

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
)

// EvaluateJSON is the shared strict JSON entry point for HTTP and WebAssembly.
// Only omitted arrays default to empty; explicit null and unknown fields fail.
func EvaluateJSON(data []byte) (Result, error) {
	return EvaluateJSONWithLimits(context.Background(), data, Limits{})
}

// EvaluateJSONWithLimits uses the same schema and validation as EvaluateJSON,
// with optional byte/count limits and cooperative cancellation.
func EvaluateJSONWithLimits(ctx context.Context, data []byte, limits Limits) (Result, error) {
	if err := checkContext(ctx); err != nil {
		return Result{}, err
	}
	if limits.MaxBodyBytes > 0 && len(data) > limits.MaxBodyBytes {
		return Result{}, invalid("body_too_large", "request", fmt.Sprintf("Request body must be at most %d bytes.", limits.MaxBodyBytes))
	}
	fields, err := decodeObject(ctx, data, "request", "initial", "operations")
	if err != nil {
		return Result{}, err
	}
	var req Request
	if raw, ok := fields["initial"]; ok {
		items, err := decodeArray(ctx, raw, "initial", limits.MaxInitial)
		if err != nil {
			return Result{}, err
		}
		req.Initial = make([]string, len(items))
		for i, item := range items {
			if err := checkContext(ctx); err != nil {
				return Result{}, err
			}
			if err := decodeString(item, fmt.Sprintf("initial[%d]", i), &req.Initial[i]); err != nil {
				return Result{}, err
			}
		}
	}
	if raw, ok := fields["operations"]; ok {
		items, err := decodeArray(ctx, raw, "operations", limits.MaxOperations)
		if err != nil {
			return Result{}, err
		}
		req.Operations = make([]Operation, len(items))
		for i, item := range items {
			if err := checkContext(ctx); err != nil {
				return Result{}, err
			}
			field := fmt.Sprintf("operations[%d]", i)
			op, err := decodeObject(ctx, item, field, "op", "value")
			if err != nil {
				return Result{}, err
			}
			if err := decodeString(op["op"], field+".op", &req.Operations[i].Op); err != nil {
				return Result{}, err
			}
			if err := decodeString(op["value"], field+".value", &req.Operations[i].Value); err != nil {
				return Result{}, err
			}
		}
	}
	return EvaluateWithLimits(ctx, req, limits)
}

func decodeObject(ctx context.Context, data []byte, field string, allowed ...string) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil, invalid("invalid_json", field, "Expected a JSON object.")
	}
	fields := make(map[string]json.RawMessage, len(allowed))
	for decoder.More() {
		if err := checkContext(ctx); err != nil {
			return nil, err
		}
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok {
			return nil, invalid("invalid_json", field, "Malformed JSON object.")
		}
		keyField := key
		if field != "request" {
			keyField = field + "." + key
		} else if key == "" {
			keyField = `request[""]`
		}
		known := false
		for _, candidate := range allowed {
			known = known || key == candidate
		}
		if !known {
			return nil, invalid("unknown_field", keyField, "Unknown field.")
		}
		if _, exists := fields[key]; exists {
			return nil, invalid("duplicate_field", keyField, "Duplicate field.")
		}
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return nil, invalid("invalid_json", keyField, "Malformed JSON value.")
		}
		fields[key] = raw
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') {
		return nil, invalid("invalid_json", field, "Malformed JSON object.")
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, invalid("invalid_json", field, "Expected exactly one JSON object.")
	}
	return fields, nil
}

func decodeArray(ctx context.Context, data []byte, field string, limit int) ([]json.RawMessage, error) {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || data[0] != '[' {
		return nil, invalid("invalid_json", field, "Expected an array.")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if _, err := decoder.Token(); err != nil {
		return nil, invalid("invalid_json", field, "Malformed JSON array.")
	}
	items := make([]json.RawMessage, 0)
	for decoder.More() {
		if err := checkContext(ctx); err != nil {
			return nil, err
		}
		if limit > 0 && len(items) >= limit {
			return nil, invalid("input_limit", field, fmt.Sprintf("At most %d entries are allowed.", limit))
		}
		var item json.RawMessage
		if err := decoder.Decode(&item); err != nil {
			return nil, invalid("invalid_json", field, "Malformed JSON array.")
		}
		items = append(items, item)
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim(']') {
		return nil, invalid("invalid_json", field, "Malformed JSON array.")
	}
	return items, nil
}

func decodeString(data []byte, field string, value *string) error {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || data[0] != '"' || json.Unmarshal(data, value) != nil {
		return invalid("invalid_json", field, "Expected a string.")
	}
	return nil
}
