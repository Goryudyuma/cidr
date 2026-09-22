import assert from 'node:assert/strict';
import test from 'node:test';
import { brotliCompressSync, brotliDecompressSync, constants, gzipSync, gunzipSync } from 'node:zlib';
import {
  decodeShare, decodeSharedState, encodeShare, encodeSharedState,
  MAX_SHARE_HASH_LENGTH, MAX_SHARE_STATE_BYTES, MAX_SHARE_WIRE_BYTES, ShareError,
} from '../../web/src/share.ts';

// Node 24.7.0 strips the type-only imports in share.ts without extra flags.
const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(JSON.stringify(value));
const wireOf = (state) => JSON.parse(new TextDecoder().decode(encodeSharedState(state)));
const shareError = (code, field) => (error) => error instanceof ShareError
  && error.code === code && (field === undefined || error.field === field);

function state(initial = [], draft = initial.join('\n')) {
  return {
    version: 1,
    request: { initial, operations: [{ op: 'add', value: '::1' }, { op: 'remove', value: '0.0.0.0' }] },
    inputs: { initial: draft, operation: ' \r\n pending 🐦 ', zoom: '\t unfinished zoom\n' },
    view: {
      mode: 'fit',
      viewports: {
        ipv6: { start: '0', end: '340282366920938463463374607431768211455', label: { kind: 'custom', text: '全体 🐦' } },
      },
      selected: Number.MAX_SAFE_INTEGER,
      relatedPage: Number.MAX_SAFE_INTEGER,
    },
    output: { tab: 'ranges', cidrPage: 2, rangePage: 3, historyPage: 4 },
  };
}

function compression(codec) {
  return {
    compress(data) {
      return { codec, data: codec === 'g' ? gzipSync(data) : brotliCompressSync(data, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 6 },
      }) };
    },
    decompress(kind, data) {
      assert.equal(kind, codec);
      return kind === 'g'
        ? gunzipSync(data, { maxOutputLength: MAX_SHARE_WIRE_BYTES })
        : brotliDecompressSync(data, { maxOutputLength: MAX_SHARE_WIRE_BYTES });
    },
  };
}

test('gzip and Brotli envelopes preserve the complete state and expose an independently readable wire format', async () => {
  const initial = ['192.0.2.0/24', '::1', '192.0.2.0/24', '2001:db8::/32'];
  const original = state(initial, ` \r\n${initial.join('\r\n')}\n未適用 🐦\t `);
  original.request.operations = [
    { op: 'remove', value: '::1' }, { op: 'add', value: '::1' },
    { op: 'add', value: '::1' }, { op: 'remove', value: '192.0.2.1' },
  ];
  for (const codec of ['g', 'b']) {
    const adapter = compression(codec);
    const hash = await encodeShare(original, adapter);
    assert.ok(hash.startsWith(`#s=2.${codec}.`));
    assert.deepEqual(await decodeShare(hash, adapter), original);
    const packed = JSON.parse(adapter.decompress(codec, Buffer.from(hash.slice(7), 'base64url')).toString('utf8'));
    assert.equal(packed.version, 2);
    assert.deepEqual(packed.initial, initial);
    assert.deepEqual(packed.operations, [[1, '::1'], [0, '::1'], [0, '::1'], [1, '192.0.2.1']]);
    assert.deepEqual(packed.view, original.view);
    assert.deepEqual(packed.output, original.output);
  }
});

test('2,500 seeded UTF-16 cases preserve ordered inputs, operations, and every draft code unit', () => {
  let seed = 0x31ad074b;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  const characters = ['x', '\n', '\r', '\t', '\u0000', '\u000b', '"', '\\', 'あ', '🐦', '\ud800', '\udfff'];
  const text = () => Array.from({ length: random() % 12 }, () => characters[random() % characters.length]).join('');
  let differences = 0;
  let literals = 0;
  for (let iteration = 0; iteration < 2500; iteration++) {
    // IP semantics belong to Go. This codec must also preserve invalid drafts
    // and UTF-16 strings so that subsequent validation sees the original input.
    const initial = Array.from({ length: random() % 8 }, text);
    if (initial.length > 1) initial.push(initial[0]);
    const base = initial.join('\n');
    const start = random() % (base.length + 1);
    const end = start + random() % (base.length - start + 1);
    const draft = iteration % 3 === 0 ? base : iteration % 3 === 1
      ? base.slice(0, start) + text() + base.slice(end) : text();
    const original = state(initial, draft);
    original.request.operations = Array.from({ length: random() % 8 }, () => ({
      op: random() % 2 ? 'add' : 'remove', value: text(),
    }));
    original.inputs.operation = text();
    original.inputs.zoom = text();
    const encoded = encodeSharedState(original);
    assert.deepEqual(decodeSharedState(encoded), original, `seed case ${iteration}`);
    if (Array.isArray(JSON.parse(new TextDecoder().decode(encoded)).inputs[0])) differences++;
    else literals++;
  }
  assert.ok(differences > 100, 'exercise difference encoding');
  assert.ok(literals > 100, 'exercise literal encoding');
});

test('draft differences preserve trailing edits and boundaries inside surrogate pairs', () => {
  const initial = ['192.0.2.0/24', '198.51.100.0/24', '🐦', '2001:db8::/32'];
  const base = initial.join('\n');
  const identical = wireOf(state(initial));
  assert.deepEqual(identical.inputs[0], [base.length, 0, '']);
  const drafts = [
    `${base}\r\n\t `, ` \r\n${base}`, base.replace('🐦', '🐧'),
    base.slice(0, base.indexOf('🐦') + 1), `\ud800${base}\udfff`, '',
  ];
  for (const draft of drafts) {
    const original = state(initial, draft);
    const wire = wireOf(original);
    assert.deepEqual(decodeSharedState(bytes(wire)), original);
    if (Array.isArray(wire.inputs[0])) {
      assert.ok(Buffer.byteLength(JSON.stringify(wire.inputs[0])) < Buffer.byteLength(JSON.stringify(draft)));
    }
  }
  const changedBird = wireOf(state(initial, base.replace('🐦', '🐧'))).inputs[0];
  assert.equal(changedBird[0], base.indexOf('🐦') + 1);
  assert.equal(changedBird[2], '🐧'.slice(1));
  assert.equal(wireOf(state([], '🐦')).inputs[0], '🐦', 'short literals avoid difference overhead');
});

test('malformed differences, tuples, schema fields, and UTF-8 fail before restoring a state', () => {
  const valid = wireOf(state(['192.0.2.0/24']));
  const malformed = [
    [-1, 0, ''], [0.5, 0, ''], [Number.MAX_SAFE_INTEGER + 1, 0, ''],
    [Number.MAX_SAFE_INTEGER, 0, ''], [0, Number.MAX_SAFE_INTEGER, ''],
    [8, 8, ''], [0, 0, []], [0, 0], [0, 0, '', 'extra'], { prefix: 0 },
  ].map((difference) => ({ ...valid, inputs: [difference, '', ''] }));
  malformed.push(
    { ...valid, inputs: ['', ''] },
    { ...valid, operations: [[0]] },
    { ...valid, operations: [[0, '::1', 'extra']] },
    { ...valid, operations: [['0', '::1']] },
    { ...valid, operations: [[2, '::1']] },
    { ...valid, operations: [[1, 'x'.repeat(129)]] },
    { ...valid, initial: [null] },
    { ...valid, extra: true },
    { ...valid, output: { ...valid.output, extra: true } },
    { ...valid, view: { ...valid.view, selected: Number.MAX_SAFE_INTEGER + 1 } },
  );
  for (const wire of malformed) assert.throws(() => decodeSharedState(bytes(wire)), shareError('invalid'));
  assert.throws(() => decodeSharedState(Uint8Array.of(0xff)), shareError('invalid'));
  assert.throws(() => decodeSharedState(bytes({ ...valid, version: 1 })), shareError('unsupported', 'version'));
  assert.throws(() => decodeSharedState(bytes({ ...valid, version: 3 })), shareError('unsupported', 'version'));
});

test('URL failures are distinct from wire and logical-state size failures', async () => {
  const adapter = compression('g');
  assert.equal(await decodeShare('', adapter), null);
  assert.equal(await decodeShare('#unrelated', adapter), null);
  await assert.rejects(() => decodeShare('#s=1.AA', adapter), shareError('unsupported', 'version'));
  await assert.rejects(() => decodeShare('#s=2.x.AA', adapter), shareError('unsupported', 'share.codec'));
  for (const encoded of ['A', 'AB', 'AA=', 'A+']) {
    await assert.rejects(() => decodeShare(`#s=2.g.${encoded}`, adapter), shareError('invalid'));
  }
  await assert.rejects(() => decodeShare('#s=2.g.' + 'A'.repeat(MAX_SHARE_HASH_LENGTH), adapter), shareError('tooLarge', 'share.url'));
  await assert.rejects(() => encodeShare(state(), {
    ...adapter, compress: () => ({ codec: 'g', data: new Uint8Array(24_571) }),
  }), shareError('tooLarge', 'share.url'));
  assert.throws(() => decodeSharedState(new Uint8Array(MAX_SHARE_WIRE_BYTES + 1)), shareError('tooLarge', 'share.state'));
  assert.throws(() => encodeSharedState(state([], 'x'.repeat(MAX_SHARE_WIRE_BYTES))), shareError('tooLarge', 'share.state'));
  assert.throws(() => encodeSharedState(state([], 'x'.repeat(MAX_SHARE_STATE_BYTES))), shareError('tooLarge', 'share.state'));
});

test('reference expansion checks the exact restored UTF-8 budget, including a split surrogate pair', () => {
  // Compact operation tuples expand substantially. The wire remains under
  // 8 MiB while the logical state reaches exactly 16 MiB. Reusing references
  // here avoids allocating the expected half-million operation objects.
  const original = state(['🐦'], '🐧');
  original.request.operations = Array(500_000).fill({ op: 'remove', value: '' });
  original.inputs.operation = '';
  original.inputs.zoom = '';
  const padding = MAX_SHARE_STATE_BYTES - bytes(original).byteLength;
  assert.ok(padding > 0);
  const middle = '🐧'.slice(1) + 'x'.repeat(padding);
  const wire = {
    version: 2,
    initial: original.request.initial,
    operations: Array(500_000).fill([1, '']),
    inputs: [[1, 0, middle], '', ''],
    view: original.view,
    output: original.output,
  };
  const encoded = bytes(wire);
  assert.ok(encoded.byteLength < MAX_SHARE_WIRE_BYTES);
  const restored = decodeSharedState(encoded);
  assert.equal(restored.request.operations.length, 500_000);
  assert.equal(restored.inputs.initial, '🐧' + 'x'.repeat(padding));
  assert.equal(bytes(restored).byteLength, MAX_SHARE_STATE_BYTES);
  wire.inputs[0][2] += 'x';
  assert.throws(() => decodeSharedState(bytes(wire)), shareError('tooLarge', 'share.state'));
});
