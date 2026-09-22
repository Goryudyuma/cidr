//go:build js && wasm

package main

import (
	"encoding/json"
	"syscall/js"

	"github.com/goryudyuma/cidr/core"
	"github.com/goryudyuma/cidr/internal/sharecodec"
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

func shareError(err error) map[string]any {
	detail, ok := err.(*sharecodec.Error)
	if !ok {
		detail = &sharecodec.Error{Code: "invalid", Message: "The shared data is invalid.", Field: "share"}
	}
	return map[string]any{"error": map[string]any{
		"code": detail.Code, "message": detail.Message, "field": detail.Field,
	}}
}

func invalidShare() *sharecodec.Error {
	return &sharecodec.Error{Code: "invalid", Message: "Expected the shared data as a Uint8Array.", Field: "share"}
}

func shareInput(value js.Value, limit int, field string) ([]byte, error) {
	if value.Type() != js.TypeObject || !value.InstanceOf(js.Global().Get("Uint8Array")) {
		return nil, invalidShare()
	}
	length := value.Get("byteLength")
	if length.Type() != js.TypeNumber || length.Float() < 0 {
		return nil, invalidShare()
	}
	if length.Float() > float64(limit) {
		return nil, &sharecodec.Error{Code: "tooLarge", Message: "The shared data exceeds the size limit.", Field: field}
	}
	if length.Float() != float64(length.Int()) {
		return nil, invalidShare()
	}
	data := make([]byte, length.Int())
	if js.CopyBytesToGo(data, value) != len(data) {
		return nil, invalidShare()
	}
	return data, nil
}

func shareOutput(data []byte) js.Value {
	output := js.Global().Get("Uint8Array").New(len(data))
	js.CopyBytesToJS(output, data)
	return output
}

func shareCompress(_ js.Value, args []js.Value) (response any) {
	defer func() {
		if recover() != nil {
			response = shareError(invalidShare())
		}
	}()
	if len(args) != 1 {
		return shareError(invalidShare())
	}
	input, err := shareInput(args[0], sharecodec.MaxStateBytes, "share.state")
	if err != nil {
		return shareError(err)
	}
	result, err := sharecodec.Compress(input)
	if err != nil {
		return shareError(err)
	}
	return map[string]any{"codec": result.Codec, "data": shareOutput(result.Data)}
}

func shareDecompress(_ js.Value, args []js.Value) (response any) {
	defer func() {
		if recover() != nil {
			response = shareError(invalidShare())
		}
	}()
	if len(args) != 2 || args[0].Type() != js.TypeString {
		return shareError(invalidShare())
	}
	codec := args[0].String()
	if codec != "g" && codec != "b" {
		return shareError(&sharecodec.Error{Code: "unsupported", Message: "The shared compression format is unsupported.", Field: "share"})
	}
	input, err := shareInput(args[1], sharecodec.MaxEncodedBytes, "share.url")
	if err != nil {
		return shareError(err)
	}
	data, err := sharecodec.Decompress(codec, input)
	if err != nil {
		return shareError(err)
	}
	return map[string]any{"data": shareOutput(data)}
}

func main() {
	callback := js.FuncOf(evaluate)
	defer callback.Release()
	compressCallback := js.FuncOf(shareCompress)
	defer compressCallback.Release()
	decompressCallback := js.FuncOf(shareDecompress)
	defer decompressCallback.Release()
	js.Global().Set("cidrEvaluate", callback)
	js.Global().Set("cidrShareCompress", compressCallback)
	js.Global().Set("cidrShareDecompress", decompressCallback)
	if ready := js.Global().Get("cidrReady"); ready.Type() == js.TypeFunction {
		ready.Invoke()
	}
	select {}
}
