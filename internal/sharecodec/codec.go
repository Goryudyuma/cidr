// Package sharecodec provides bounded, portable compression for shared editor
// snapshots. It is independent of HTTP, JavaScript, and the snapshot schema.
package sharecodec

import (
	"bytes"
	"compress/gzip"
	"errors"
	"io"

	"github.com/andybalholm/brotli"
)

const (
	MaxStateBytes   = 8 * 1024 * 1024
	MaxEncodedBytes = (32768 - len("#s=2.b.")) * 3 / 4
)

// Error is safe to expose to a caller without including the shared data.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Field   string `json:"field"`
}

func (e *Error) Error() string { return e.Message }

func invalid() *Error {
	return &Error{Code: "invalid", Message: "The shared data is invalid.", Field: "share"}
}

func tooLarge(field string) *Error {
	return &Error{Code: "tooLarge", Message: "The shared data exceeds the size limit.", Field: field}
}

// Compressed identifies the algorithm needed to decode Data.
type Compressed struct {
	Codec string
	Data  []byte
}

var errOutputLimit = errors.New("compressed output exceeds limit")

// boundedWriter rejects writes before appending bytes beyond the URL budget.
// Each codec has its own writer, so a failed candidate cannot poison the other.
type boundedWriter struct {
	data []byte
}

func (w *boundedWriter) Write(p []byte) (int, error) {
	if len(p) > MaxEncodedBytes-len(w.data) {
		return 0, errOutputLimit
	}
	w.data = append(w.data, p...)
	return len(p), nil
}

func compress(input []byte, codec string) (data []byte, err error) {
	defer func() {
		if recover() != nil {
			data, err = nil, invalid()
		}
	}()
	output := new(boundedWriter)
	var writer io.WriteCloser
	switch codec {
	case "g":
		writer, err = gzip.NewWriterLevel(output, gzip.BestCompression)
		if err != nil {
			return nil, err
		}
	case "b":
		writer = brotli.NewWriterOptions(output, brotli.WriterOptions{Quality: 6, LGWin: 22})
	default:
		return nil, invalid()
	}
	_, writeErr := writer.Write(input)
	closeErr := writer.Close()
	if writeErr != nil {
		return nil, writeErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	return output.data, nil
}

// Compress tries both bounded encoders and returns the smaller successful
// candidate. Equal sizes choose gzip deterministically. No candidate is allowed
// to allocate an unbounded output buffer, including the fallback candidate.
func Compress(input []byte) (Compressed, error) {
	if len(input) > MaxStateBytes {
		return Compressed{}, tooLarge("share.state")
	}
	gzipData, gzipErr := compress(input, "g")
	brotliData, brotliErr := compress(input, "b")
	if gzipErr == nil && (brotliErr != nil || len(gzipData) <= len(brotliData)) {
		return Compressed{Codec: "g", Data: gzipData}, nil
	}
	if brotliErr == nil {
		return Compressed{Codec: "b", Data: brotliData}, nil
	}
	if errors.Is(gzipErr, errOutputLimit) && errors.Is(brotliErr, errOutputLimit) {
		return Compressed{}, tooLarge("share.url")
	}
	return Compressed{}, invalid()
}

// Decompress limits both encoded input and expanded output. Reading one byte
// beyond the state limit detects bombs without buffering their complete output.
// A failed or incomplete stream never returns a partially decoded snapshot.
func Decompress(codec string, input []byte) (data []byte, err error) {
	defer func() {
		if recover() != nil {
			data, err = nil, invalid()
		}
	}()
	if codec != "g" && codec != "b" {
		return nil, &Error{Code: "unsupported", Message: "The shared compression format is unsupported.", Field: "share"}
	}
	if len(input) > MaxEncodedBytes {
		return nil, tooLarge("share.url")
	}
	var reader io.Reader
	if codec == "g" {
		gzipReader, openErr := gzip.NewReader(bytes.NewReader(input))
		if openErr != nil {
			return nil, invalid()
		}
		defer gzipReader.Close()
		reader = gzipReader
	} else {
		// WBITS=23/24 is encoded in the first four bits (LSB first).
		// Reject those windows before the decoder allocates its ring buffer.
		// Our encoder uses WBITS=22 (4 MiB). The library also rejects the
		// nonstandard large-window extension because it is disabled by default.
		if len(input) > 0 && input[0]&1 != 0 && (input[0]>>1)&7 > 5 {
			return nil, invalid()
		}
		reader = brotli.NewReader(bytes.NewReader(input))
	}
	data, readErr := io.ReadAll(io.LimitReader(reader, MaxStateBytes+1))
	if len(data) > MaxStateBytes {
		return nil, tooLarge("share.state")
	}
	if readErr != nil {
		return nil, invalid()
	}
	return data, nil
}
