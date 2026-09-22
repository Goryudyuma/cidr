//go:build js && wasm

package main

import (
	"encoding/json"
	"syscall/js"

	"github.com/goryudyuma/cidr/core"
)

func evaluate(_ js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeString {
		return `{"error":{"code":"invalid_json","message":"Expected one JSON string.","field":"request"}}`
	}
	result, err := core.EvaluateJSON([]byte(args[0].String()))
	var envelope any
	if err != nil {
		envelope = struct {
			Error error `json:"error"`
		}{err}
	} else {
		envelope = struct {
			Result core.Result `json:"result"`
		}{result}
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return `{"error":{"code":"internal_error","message":"Could not encode the result.","field":"request"}}`
	}
	return string(encoded)
}

func main() {
	callback := js.FuncOf(evaluate)
	defer callback.Release()
	js.Global().Set("cidrEvaluate", callback)
	if ready := js.Global().Get("cidrReady"); ready.Type() == js.TypeFunction {
		ready.Invoke()
	}
	select {}
}
