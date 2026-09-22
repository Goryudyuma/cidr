package sharecodec

import (
	"bytes"
	"errors"
	"fmt"
	"math/rand/v2"
	"testing"

	"github.com/andybalholm/brotli"
)

func expectError(t *testing.T, err error, code, field string) {
	t.Helper()
	var detail *Error
	if !errors.As(err, &detail) || detail.Code != code || detail.Field != field {
		t.Fatalf("error = %#v, want %s at %s", err, code, field)
	}
}

func encoded(t *testing.T, codec string, input []byte) []byte {
	t.Helper()
	data, err := compress(input, codec)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestRoundTrip(t *testing.T) {
	inputs := [][]byte{
		{},
		[]byte("192.0.2.0/24\n2001:db8::/32\n日本語の入力\n"),
		bytes.Repeat([]byte{0, 1, 2, 255, 128}, 1000),
		bytes.Repeat([]byte("x"), MaxStateBytes),
	}
	for _, codec := range []string{"g", "b"} {
		for _, input := range inputs {
			t.Run(fmt.Sprintf("%s/%d", codec, len(input)), func(t *testing.T) {
				compressed := encoded(t, codec, input)
				actual, err := Decompress(codec, compressed)
				if err != nil || !bytes.Equal(actual, input) {
					t.Fatalf("round trip failed: bytes=%d, error=%v", len(actual), err)
				}
			})
		}
	}
}

func TestLimits(t *testing.T) {
	if MaxEncodedBytes != 24570 {
		t.Fatalf("compressed limit = %d, want 24570", MaxEncodedBytes)
	}
	result, err := Compress(make([]byte, MaxStateBytes+1))
	expectError(t, err, "tooLarge", "share.state")
	if result.Data != nil {
		t.Fatal("oversized state returned partial data")
	}
	random := rand.New(rand.NewPCG(1, 2))
	incompressible := make([]byte, 64*1024)
	for i := range incompressible {
		incompressible[i] = byte(random.Uint32())
	}
	result, err = Compress(incompressible)
	expectError(t, err, "tooLarge", "share.url")
	if result.Data != nil {
		t.Fatal("oversized URL returned partial data")
	}
	for _, codec := range []string{"g", "b"} {
		t.Run(codec, func(t *testing.T) {
			data, err := Decompress(codec, make([]byte, MaxEncodedBytes+1))
			expectError(t, err, "tooLarge", "share.url")
			if data != nil {
				t.Fatal("oversized encoded input returned partial data")
			}
			bomb := encoded(t, codec, bytes.Repeat([]byte("x"), MaxStateBytes+1))
			data, err = Decompress(codec, bomb)
			expectError(t, err, "tooLarge", "share.state")
			if data != nil {
				t.Fatal("decompression bomb returned partial data")
			}
		})
	}
}

func TestBoundedWriter(t *testing.T) {
	output := new(boundedWriter)
	if n, err := output.Write(make([]byte, MaxEncodedBytes)); n != MaxEncodedBytes || err != nil {
		t.Fatalf("exact-limit write = (%d, %v)", n, err)
	}
	if n, err := output.Write([]byte{1}); n != 0 || !errors.Is(err, errOutputLimit) {
		t.Fatalf("excess write = (%d, %v)", n, err)
	}
	if len(output.data) != MaxEncodedBytes {
		t.Fatal("writer exceeded its allocation budget")
	}
}

func TestMalformed(t *testing.T) {
	for _, codec := range []string{"g", "b"} {
		t.Run(codec, func(t *testing.T) {
			valid := encoded(t, codec, []byte("shared snapshot with IPv6 ::/0"))
			for size := 0; size < len(valid); size++ {
				data, err := Decompress(codec, valid[:size])
				expectError(t, err, "invalid", "share")
				if data != nil {
					t.Fatalf("truncated input at %d returned partial data", size)
				}
			}
			for _, broken := range [][]byte{{255}, []byte("not compressed"), append(bytes.Clone(valid), 255)} {
				data, err := Decompress(codec, broken)
				expectError(t, err, "invalid", "share")
				if data != nil {
					t.Fatal("malformed input returned partial data")
				}
			}
		})
	}
	data, err := Decompress("unknown", []byte{})
	expectError(t, err, "unsupported", "share")
	if data != nil {
		t.Fatal("unsupported codec returned data")
	}
}

func TestCompressionChoice(t *testing.T) {
	// This deterministic ternary source favors gzip, while the text examples
	// favor Brotli. Check both selection branches against their actual sizes.
	random := rand.New(rand.NewPCG(71, 93))
	ternary := make([]byte, 500)
	for i := range ternary {
		random.IntN(100)
		ternary[i] = byte(random.IntN(3))
	}
	inputs := [][]byte{
		{},
		[]byte(`{"initial":["192.0.2.0/24"],"operations":[]}`),
		bytes.Repeat([]byte("abcdefghijklm"), 1000),
		ternary,
	}
	winners := make(map[string]bool)
	for _, input := range inputs {
		result, err := Compress(input)
		if err != nil {
			t.Fatal(err)
		}
		gzipData, brotliData := encoded(t, "g", input), encoded(t, "b", input)
		wantCodec, wantData := "g", gzipData
		if len(brotliData) < len(gzipData) {
			wantCodec, wantData = "b", brotliData
		}
		if result.Codec != wantCodec || !bytes.Equal(result.Data, wantData) {
			t.Fatalf("choice = %s/%d, want %s/%d", result.Codec, len(result.Data), wantCodec, len(wantData))
		}
		winners[result.Codec] = true
		decoded, err := Decompress(result.Codec, result.Data)
		if err != nil || !bytes.Equal(decoded, input) {
			t.Fatalf("selected candidate did not round trip: %v", err)
		}
	}
	if !winners["g"] || !winners["b"] {
		t.Fatalf("expected data-dependent selection of both codecs, got %v", winners)
	}
}

func TestCandidateLimitDoesNotPreventFallback(t *testing.T) {
	random := rand.New(rand.NewPCG(1, 2))
	input := make([]byte, MaxEncodedBytes-4)
	for i := range input {
		input[i] = byte(random.Uint32())
	}
	if _, err := compress(input, "g"); !errors.Is(err, errOutputLimit) {
		t.Fatalf("gzip fixture must exceed URL budget, got %v", err)
	}
	result, err := Compress(input)
	if err != nil || result.Codec != "b" || len(result.Data) > MaxEncodedBytes {
		t.Fatalf("Brotli fallback failed: codec=%s, bytes=%d, error=%v", result.Codec, len(result.Data), err)
	}
	decoded, err := Decompress(result.Codec, result.Data)
	if err != nil || !bytes.Equal(input, decoded) {
		t.Fatalf("fallback round trip failed: %v", err)
	}
}

func TestBrotliWindowLimit(t *testing.T) {
	for _, window := range []int{22, 23, 24} {
		var output bytes.Buffer
		writer := brotli.NewWriterOptions(&output, brotli.WriterOptions{Quality: 6, LGWin: window})
		input := bytes.Repeat([]byte("window limit"), 1000)
		if _, err := writer.Write(input); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		data, err := Decompress("b", output.Bytes())
		if window == 22 {
			if err != nil || !bytes.Equal(input, data) {
				t.Fatalf("supported window failed: %v", err)
			}
		} else {
			expectError(t, err, "invalid", "share")
			if data != nil {
				t.Fatal("unsupported window returned data")
			}
		}
	}
	// 0x11 is the reserved large-window extension; do not enable it even when
	// its following bits request a very large decoder allocation.
	data, err := Decompress("b", []byte{0x11, 0xff, 0xff, 0xff})
	expectError(t, err, "invalid", "share")
	if data != nil {
		t.Fatal("large-window extension returned data")
	}
}

func FuzzDecompress(f *testing.F) {
	f.Add([]byte{})
	f.Add([]byte{255})
	f.Add([]byte("not a compressed snapshot"))
	for _, codec := range []string{"g", "b"} {
		data, err := compress([]byte("192.0.2.1/32"), codec)
		if err != nil {
			f.Fatal(err)
		}
		f.Add(data)
	}
	f.Fuzz(func(t *testing.T, input []byte) {
		for _, codec := range []string{"g", "b"} {
			data, err := Decompress(codec, input)
			if err != nil {
				var detail *Error
				if !errors.As(err, &detail) || data != nil {
					t.Fatalf("invalid failure result: %v, bytes=%d", err, len(data))
				}
			} else if len(data) > MaxStateBytes {
				t.Fatal("decompression exceeded the state budget")
			}
		}
	})
}
