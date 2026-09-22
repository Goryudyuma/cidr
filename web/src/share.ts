import type { Family, Operation } from './types';

export interface SharedView {
  mode: 'fit' | 'all';
  viewports: Partial<Record<Family, {
    start: string;
    end: string;
    label: { kind: 'custom'; text: string } | { kind: 'selected' };
  }>>;
  selected?: number;
  relatedPage: number;
}

export interface SharedState {
  version: 1;
  request: { initial: string[]; operations: Operation[] };
  inputs: { initial: string; operation: string; zoom: string };
  view: SharedView;
  output: { tab: 'cidrs' | 'ranges'; cidrPage: number; rangePage: number; historyPage: number };
}

export const MAX_SHARE_HASH_LENGTH = 32_768;
export const MAX_SHARE_STATE_BYTES = 16 * 1024 * 1024;
export const MAX_SHARE_WIRE_BYTES = 8 * 1024 * 1024;
const VERSION = 2;
const MAX_COMPRESSED_BYTES = Math.floor((MAX_SHARE_HASH_LENGTH - '#s=2.g.'.length) * 3 / 4);
const familyMax: Record<Family, bigint> = { ipv4: (1n << 32n) - 1n, ipv6: (1n << 128n) - 1n };

export type ShareCodec = 'g' | 'b';
export interface ShareCompression {
  compress(data: Uint8Array): { codec: ShareCodec; data: Uint8Array } | Promise<{ codec: ShareCodec; data: Uint8Array }>;
  // The adapter must enforce MAX_SHARE_WIRE_BYTES while decompressing, rather
  // than buffering an unbounded result and relying on the subsequent check.
  decompress(codec: ShareCodec, data: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

type InitialInput = string | [prefixChars: number, suffixChars: number, middle: string];
interface SharedWireV2 {
  version: 2;
  initial: string[];
  operations: [0 | 1, string][];
  inputs: [InitialInput, string, string];
  view: SharedView;
  output: SharedState['output'];
}

export class ShareError extends Error {
  readonly code: 'invalid' | 'unsupported' | 'tooLarge';
  readonly field: string;
  constructor(code: ShareError['code'], message?: string, field = 'share') {
    super(message ?? ({
      invalid: 'The shared link is invalid.',
      unsupported: 'This shared link or browser is not supported.',
      tooLarge: 'The shared state exceeds the size limit.',
    })[code]);
    this.name = 'ShareError';
    this.code = code;
    this.field = field;
  }
}

function invalid(field: string): never {
  throw new ShareError('invalid', `Invalid shared state field: ${field}.`, field);
}

function tooLarge(field: 'share.url' | 'share.state'): never {
  throw new ShareError('tooLarge', undefined, field);
}

function record(value: unknown, field: string, required: string[], optional: string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  const result = value as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(result, key))) invalid(field);
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(result).some((key) => !allowed.has(key))) invalid(field);
  return result;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(field);
  return value;
}

function address(value: unknown, field: string): string {
  const result = string(value, field);
  // Go performs IP/CIDR semantic validation after decoding the request.
  if (result.length > 128 || new TextEncoder().encode(result).byteLength > 128) invalid(field);
  return result;
}

function array(value: unknown, field: string, minimumItemBytes: number): unknown[] {
  if (!Array.isArray(value)) invalid(field);
  // Even the smallest possible items must fit the restored JSON budget. The
  // decompressed wire limit additionally bounds every array before parsing.
  if (value.length > Math.floor((MAX_SHARE_STATE_BYTES + 1) / minimumItemBytes)) tooLarge('share.state');
  return value as unknown[];
}

function initialAddresses(value: unknown): string[] {
  return array(value, 'request.initial', 3)
    .map((item, position) => address(item, `request.initial[${position}]`));
}

function index(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(field);
  return value;
}

function coordinate(value: unknown, family: Family, field: string): string {
  const result = string(value, field);
  // Check the decimal width before BigInt so hostile inputs cannot trigger a
  // conversion of an arbitrarily long integer. IPv6's maximum is 39 digits.
  if (result.length > (family === 'ipv4' ? 10 : 39) || !/^(?:0|[1-9]\d*)$/.test(result)) invalid(field);
  if (BigInt(result) > familyMax[family]) invalid(field);
  return result;
}

function sharedView(value: unknown): SharedView {
  const view = record(value, 'view', ['mode', 'viewports', 'relatedPage'], ['selected']);
  if (view.mode !== 'fit' && view.mode !== 'all') invalid('view.mode');
  const ports = record(view.viewports, 'view.viewports', [], ['ipv4', 'ipv6']);
  const viewports: SharedView['viewports'] = {};
  for (const family of ['ipv4', 'ipv6'] as const) {
    if (!Object.hasOwn(ports, family)) continue;
    const path = `view.viewports.${family}`;
    const viewport = record(ports[family], path, ['start', 'end', 'label']);
    const start = coordinate(viewport.start, family, `${path}.start`);
    const end = coordinate(viewport.end, family, `${path}.end`);
    if (BigInt(start) > BigInt(end)) invalid(path);
    const label = record(viewport.label, `${path}.label`, ['kind'], ['text']);
    if (label.kind === 'custom') {
      const text = string(label.text, `${path}.label.text`);
      if (text.length > 256 || [...text].length > 128) invalid(`${path}.label.text`);
      viewports[family] = { start, end, label: { kind: 'custom', text } };
    } else if (label.kind === 'selected') {
      if (Object.hasOwn(label, 'text')) invalid(`${path}.label.text`);
      viewports[family] = { start, end, label: { kind: 'selected' } };
    } else invalid(`${path}.label.kind`);
  }
  const result: SharedView = { mode: view.mode, viewports, relatedPage: index(view.relatedPage, 'view.relatedPage') };
  if (Object.hasOwn(view, 'selected')) result.selected = index(view.selected, 'view.selected');
  return result;
}

function sharedOutput(value: unknown): SharedState['output'] {
  const output = record(value, 'output', ['tab', 'cidrPage', 'rangePage', 'historyPage']);
  if (output.tab !== 'cidrs' && output.tab !== 'ranges') invalid('output.tab');
  return {
    tab: output.tab,
    cidrPage: index(output.cidrPage, 'output.cidrPage'),
    rangePage: index(output.rangePage, 'output.rangePage'),
    historyPage: index(output.historyPage, 'output.historyPage'),
  };
}

function sharedState(value: unknown): SharedState {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const version = (value as Record<string, unknown>).version;
    if (typeof version === 'number' && Number.isSafeInteger(version) && version !== 1) {
      throw new ShareError('unsupported', 'Unsupported shared state version.', 'version');
    }
  }
  const state = record(value, 'share', ['version', 'request', 'inputs', 'view', 'output']);
  if (state.version !== 1) invalid('version');
  const request = record(state.request, 'request', ['initial', 'operations']);
  const initial = initialAddresses(request.initial);
  const operations = array(request.operations, 'request.operations', 24).map((value, position): Operation => {
    const path = `request.operations[${position}]`;
    const operation = record(value, path, ['op', 'value']);
    if (operation.op !== 'add' && operation.op !== 'remove') invalid(`${path}.op`);
    return { op: operation.op, value: address(operation.value, `${path}.value`) };
  });
  const inputs = record(state.inputs, 'inputs', ['initial', 'operation', 'zoom']);
  return {
    version: 1,
    request: { initial, operations },
    inputs: {
      initial: string(inputs.initial, 'inputs.initial'),
      operation: string(inputs.operation, 'inputs.operation'),
      zoom: string(inputs.zoom, 'inputs.zoom'),
    },
    view: sharedView(state.view),
    output: sharedOutput(state.output),
  };
}

function serialized(value: unknown, limit: number): { json: string; bytes: Uint8Array<ArrayBuffer> } {
  const json = JSON.stringify(value);
  if (typeof json !== 'string') invalid('share');
  if (json.length > limit) tooLarge('share.state');
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > limit) tooLarge('share.state');
  return { json, bytes };
}

// Count the exact UTF-8 size of JSON.stringify(parts.join('')) without joining
// the parts. A surrogate pair can cross a difference boundary; lone surrogates
// instead use JSON's six-byte escape. This checks the budget before expansion.
function jsonStringBytes(parts: string[], limit = MAX_SHARE_STATE_BYTES): number {
  let size = 2;
  let highSurrogate = false;
  for (const part of parts) {
    for (let position = 0; position < part.length; position++) {
      const code = part.charCodeAt(position);
      if (highSurrogate) {
        highSurrogate = false;
        if (code >= 0xdc00 && code <= 0xdfff) {
          size += 4;
          if (size > limit) tooLarge('share.state');
          continue;
        }
        size += 6;
      }
      if (code >= 0xd800 && code <= 0xdbff) highSurrogate = true;
      else if (code >= 0xdc00 && code <= 0xdfff) size += 6;
      else if (code < 0x20) size += [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
      else if (code === 0x22 || code === 0x5c) size += 2;
      else size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
      if (size > limit) tooLarge('share.state');
    }
  }
  if (highSurrogate) size += 6;
  if (size > limit) tooLarge('share.state');
  return size;
}

function initialInput(initial: string[], draft: string): InitialInput {
  const base = initial.join('\n');
  let prefix = 0;
  const length = Math.min(base.length, draft.length);
  while (prefix < length && base.charCodeAt(prefix) === draft.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < length - prefix
    && base.charCodeAt(base.length - suffix - 1) === draft.charCodeAt(draft.length - suffix - 1)) suffix++;
  const middle = draft.slice(prefix, draft.length - suffix);
  // Positions use UTF-16 code units, exactly as String.length and slice do.
  // Select the difference only when its serialized bytes are actually smaller.
  const differenceSize = String(prefix).length + String(suffix).length + 4 + jsonStringBytes([middle]);
  return differenceSize < jsonStringBytes([draft]) ? [prefix, suffix, middle] : draft;
}

function pack(state: SharedState): SharedWireV2 {
  return {
    version: 2,
    initial: state.request.initial,
    operations: state.request.operations.map(({ op, value }) => [op === 'add' ? 0 : 1, value]),
    inputs: [initialInput(state.request.initial, state.inputs.initial), state.inputs.operation, state.inputs.zoom],
    view: state.view,
    output: state.output,
  };
}

function tuple(value: unknown, field: string, length: number): unknown[] {
  if (!Array.isArray(value) || value.length !== length) invalid(field);
  return value as unknown[];
}

function initialInputParts(value: unknown, initial: string[]): string[] {
  if (typeof value === 'string') return [value];
  const difference = tuple(value, 'inputs.initial', 3);
  const prefix = index(difference[0], 'inputs.initial.prefix');
  const suffix = index(difference[1], 'inputs.initial.suffix');
  const middle = string(difference[2], 'inputs.initial.middle');
  const base = initial.join('\n');
  if (prefix > base.length || suffix > base.length - prefix) invalid('inputs.initial');
  return [base.slice(0, prefix), middle, base.slice(base.length - suffix)];
}

function unpackV2(value: unknown): SharedState {
  const wire = record(value, 'share', ['version', 'initial', 'operations', 'inputs', 'view', 'output']);
  if (wire.version !== 2) invalid('version');
  const initial = initialAddresses(wire.initial);
  const operations = array(wire.operations, 'request.operations', 24).map((value, position): Operation => {
    const path = `request.operations[${position}]`;
    const operation = tuple(value, path, 2);
    if (operation[0] !== 0 && operation[0] !== 1) invalid(`${path}.op`);
    return { op: operation[0] === 0 ? 'add' : 'remove', value: address(operation[1], `${path}.value`) };
  });
  const inputs = tuple(wire.inputs, 'inputs', 3);
  const state: SharedState = {
    version: 1,
    request: { initial, operations },
    inputs: { initial: '', operation: string(inputs[1], 'inputs.operation'), zoom: string(inputs[2], 'inputs.zoom') },
    view: sharedView(wire.view),
    output: sharedOutput(wire.output),
  };
  const remaining = MAX_SHARE_STATE_BYTES - serialized(state, MAX_SHARE_STATE_BYTES).bytes.byteLength + 2;
  const parts = initialInputParts(inputs[0], initial);
  jsonStringBytes(parts, remaining);
  state.inputs.initial = parts.join('');
  return sharedState(state);
}

// Retain earlier entries when adding future wire formats. The unpublished v1
// format is intentionally unsupported; the UI's SharedState.version stays 1.
const wireDecoders: Readonly<Record<number, ((value: unknown) => SharedState) | undefined>> = { 2: unpackV2 };

/** Serialize the lossless, versioned wire format independently of compression. */
export function encodeSharedState(value: SharedState): Uint8Array<ArrayBuffer> {
  try {
    const state = sharedState(JSON.parse(serialized(value, MAX_SHARE_STATE_BYTES).json));
    return serialized(pack(state), MAX_SHARE_WIRE_BYTES).bytes;
  } catch (error) {
    if (error instanceof ShareError) throw error;
    throw new ShareError('invalid');
  }
}

/** Decode wire bytes; keep format dispatch here when future versions are added. */
export function decodeSharedState(bytes: Uint8Array, expectedVersion?: number): SharedState {
  try {
    if (bytes.byteLength > MAX_SHARE_WIRE_BYTES) tooLarge('share.state');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('share');
    const version = (value as Record<string, unknown>).version;
    if (typeof version !== 'number' || !Number.isSafeInteger(version)) invalid('version');
    const decode = wireDecoders[version];
    if (!decode) throw new ShareError('unsupported', 'Unsupported shared state version.', 'version');
    if (expectedVersion !== undefined && version !== expectedVersion) invalid('version');
    return decode(value);
  } catch (error) {
    if (error instanceof ShareError) throw error;
    throw new ShareError('invalid');
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function compressedBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) invalid('share');
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  // Reject nonzero padding bits as well as invalid characters and lengths.
  if (base64url(bytes) !== value) invalid('share');
  return bytes;
}

export async function encodeShare(state: SharedState, compression: ShareCompression): Promise<string> {
  try {
    const result = await compression.compress(encodeSharedState(state));
    if (result.codec !== 'g' && result.codec !== 'b') invalid('share.codec');
    if (result.data.byteLength > MAX_COMPRESSED_BYTES) tooLarge('share.url');
    const hash = `#s=${VERSION}.${result.codec}.` + base64url(result.data);
    if (hash.length > MAX_SHARE_HASH_LENGTH) tooLarge('share.url');
    return hash;
  } catch (error) {
    if (error instanceof ShareError) throw error;
    throw new ShareError('invalid');
  }
}

export async function decodeShare(hash: string, compression: ShareCompression): Promise<SharedState | null> {
  if (!hash.startsWith('#s=')) return null;
  try {
    if (hash.length > MAX_SHARE_HASH_LENGTH) tooLarge('share.url');
    const header = /^#s=(\d+)\./.exec(hash);
    if (!header) invalid('share');
    if (!Object.hasOwn(wireDecoders, header[1])) throw new ShareError('unsupported', 'Unsupported shared link version.', 'version');
    const encoding = /^([a-z])\./.exec(hash.slice(header[0].length));
    if (!encoding) invalid('share.codec');
    const codec = encoding[1];
    if (codec !== 'g' && codec !== 'b') throw new ShareError('unsupported', 'Unsupported shared compression format.', 'share.codec');
    const bytes = compressedBytes(hash.slice(header[0].length + encoding[0].length));
    if (bytes.byteLength > MAX_COMPRESSED_BYTES) tooLarge('share.url');
    return decodeSharedState(await compression.decompress(codec, bytes), Number(header[1]));
  } catch (error) {
    if (error instanceof ShareError) throw error;
    throw new ShareError('invalid');
  }
}
