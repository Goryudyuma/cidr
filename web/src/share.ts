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
export const MAX_SHARE_STATE_BYTES = 1024 * 1024;
const PREFIX = '#s=1.';
const MAX_COMPRESSED_BYTES = Math.floor((MAX_SHARE_HASH_LENGTH - PREFIX.length) * 3 / 4);
const familyMax: Record<Family, bigint> = { ipv4: (1n << 32n) - 1n, ipv6: (1n << 128n) - 1n };

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
  if (!Array.isArray(request.initial)) invalid('request.initial');
  if (!Array.isArray(request.operations)) invalid('request.operations');
  const initial = request.initial.map((value, position) => address(value, `request.initial[${position}]`));
  const operations = request.operations.map((value, position): Operation => {
    const path = `request.operations[${position}]`;
    const operation = record(value, path, ['op', 'value']);
    if (operation.op !== 'add' && operation.op !== 'remove') invalid(`${path}.op`);
    return { op: operation.op, value: address(operation.value, `${path}.value`) };
  });
  const inputs = record(state.inputs, 'inputs', ['initial', 'operation', 'zoom']);
  const output = record(state.output, 'output', ['tab', 'cidrPage', 'rangePage', 'historyPage']);
  if (output.tab !== 'cidrs' && output.tab !== 'ranges') invalid('output.tab');
  return {
    version: 1,
    request: { initial, operations },
    inputs: {
      initial: string(inputs.initial, 'inputs.initial'),
      operation: string(inputs.operation, 'inputs.operation'),
      zoom: string(inputs.zoom, 'inputs.zoom'),
    },
    view: sharedView(state.view),
    output: {
      tab: output.tab,
      cidrPage: index(output.cidrPage, 'output.cidrPage'),
      rangePage: index(output.rangePage, 'output.rangePage'),
      historyPage: index(output.historyPage, 'output.historyPage'),
    },
  };
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - size) {
        // Cancel as soon as the limit is crossed; never buffer the full output
        // of an attacker-controlled gzip stream before checking its size.
        await reader.cancel().catch(() => {});
        throw new ShareError('tooLarge');
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
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

export async function encodeShare(state: SharedState): Promise<string> {
  try {
    if (typeof CompressionStream !== 'function') throw new ShareError('unsupported');
    const json = JSON.stringify(state);
    if (typeof json !== 'string') invalid('share');
    if (json.length > MAX_SHARE_STATE_BYTES) throw new ShareError('tooLarge');
    const bytes = new TextEncoder().encode(json);
    if (bytes.byteLength > MAX_SHARE_STATE_BYTES) throw new ShareError('tooLarge');
    sharedState(JSON.parse(json));
    let compressor: CompressionStream;
    try { compressor = new CompressionStream('gzip'); }
    catch { throw new ShareError('unsupported'); }
    const stream = new Blob([bytes]).stream().pipeThrough(compressor);
    const hash = PREFIX + base64url(await readBounded(stream, MAX_COMPRESSED_BYTES));
    if (hash.length > MAX_SHARE_HASH_LENGTH) throw new ShareError('tooLarge');
    return hash;
  } catch (error) {
    if (error instanceof ShareError) throw error;
    throw new ShareError('invalid');
  }
}

export async function decodeShare(hash: string): Promise<SharedState | null> {
  if (!hash.startsWith('#s=')) return null;
  try {
    if (hash.length > MAX_SHARE_HASH_LENGTH) throw new ShareError('tooLarge');
    const header = /^#s=(\d+)\./.exec(hash);
    if (!header) invalid('share');
    if (header[1] !== '1') throw new ShareError('unsupported', 'Unsupported shared link version.', 'version');
    if (typeof DecompressionStream !== 'function') throw new ShareError('unsupported');
    const bytes = compressedBytes(hash.slice(header[0].length));
    let decompressor: DecompressionStream;
    try { decompressor = new DecompressionStream('gzip'); }
    catch { throw new ShareError('unsupported'); }
    const stream = new Blob([bytes]).stream().pipeThrough(decompressor);
    const expanded = await readBounded(stream, MAX_SHARE_STATE_BYTES);
    const json = new TextDecoder('utf-8', { fatal: true }).decode(expanded);
    return sharedState(JSON.parse(json));
  } catch (error) {
    if (error instanceof ShareError) throw error;
    throw new ShareError('invalid');
  }
}
