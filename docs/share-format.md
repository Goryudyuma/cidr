# Share link format

Share links preserve an editing snapshot, including the applied request, ordered operations, exact draft text and view settings. They do not replace the request with its evaluated CIDR list.

## Versioning

The fragment is `#s=<schema>.<codec>.<base64url>`:

- `schema` identifies the data representation and its meaning. The current published format is `2`.
- `codec` is `g` for gzip or `b` for Brotli. Both codecs decode to the same JSON representation.
- `base64url` uses the URL-safe alphabet without padding. Noncanonical padding bits are rejected.

The encoder writes the current schema. A version dispatcher selects a dedicated decoder; unknown schema or codec identifiers produce an error. The experimental `#s=1.` format was retired before public release with the owner's agreement.

For future additions, introduce a new schema version whenever serialized fields or their meaning change. Preserve every previously published decoder and its fixed-link fixtures. An old decoder must map its snapshot into the current in-memory model, supplying explicit defaults for features that did not exist. Do not silently reinterpret an existing field or require old links to contain a new field.

Compression level changes, a new application build and UI-only changes do not require a new schema version. Decoders accept both supported codecs independently of which codec the current encoder chooses.

## Schema 2

The UTF-8 JSON object has exactly these keys:

```json
{
  "version": 2,
  "initial": ["192.0.2.0/30"],
  "operations": [[1, "192.0.2.1"], [0, "192.0.2.1"]],
  "inputs": [[12, 0, ""], "", ""],
  "view": {"mode": "fit", "viewports": {}, "relatedPage": 0},
  "output": {"tab": "cidrs", "cidrPage": 0, "rangePage": 0, "historyPage": 0}
}
```

`initial` preserves the applied strings, ordering and duplicates. Operations are `[kind, value]`, where `0` means add and `1` means remove; their order and original values are preserved. IP semantics are validated by the common Go core after decoding, before committing the snapshot to the UI.

`inputs` contains the initial textarea, operation input and zoom input, in that order. The last two entries are exact strings. The first entry is either an exact string or `[prefixLength, suffixLength, middle]` relative to `initial.join('\n')`. Reconstruct it as:

```text
base.slice(0, prefixLength) + middle + base.slice(base.length - suffixLength)
```

Lengths count JavaScript UTF-16 code units. Prefix and suffix must be nonnegative safe integers and must not overlap in the base. A zero-length suffix contributes an empty string. There are no recursive references. The encoder uses a difference only when its serialized representation is smaller. Whitespace, line breaks, letter case, Unicode and unapplied changes are preserved.

`view` and `output` contain the validated view and pagination structures in `web/src/share.ts`. IPv4 and IPv6 viewport endpoints are canonical decimal strings, converted to BigInt for validation and drawing. Unknown fields, invalid tuples, unsafe integers and invalid coordinates are rejected. Out-of-range selection and pagination are adjusted to the evaluated result when displayed.

## Compression and limits

The existing Worker uses the Go Wasm module for both codecs. The encoder compares gzip and Brotli output and selects the shorter valid result. Browser-native compression APIs are not needed. Go codec code is separate from the IP-set core and HTTP API. Schema 2 Brotli uses quality 6 and a 22-bit window; decoders reject larger windows and the large-window extension before allocating a history buffer larger than 4 MiB.

Limits apply independently:

| Representation | Maximum |
| --- | --- |
| Complete URL fragment | 32,768 characters |
| Compressed bytes | 24,570 bytes, with the final encoded fragment checked again |
| Decompressed schema 2 JSON | 8 MiB |
| Reconstructed in-memory snapshot represented as JSON | 16 MiB |

Decompression stops at its byte limit. Difference expansion also checks the reconstructed-state budget, so a short reference cannot bypass the limit. Limits apply to sharing only; ordinary Wasm evaluation retains its existing behavior.

The UI distinguishes an oversized URL from oversized decompressed or reconstructed data. It commits the request, inputs and view only after complete validation and successful Go evaluation. Request generations prevent canceled restores from overwriting later edits.
