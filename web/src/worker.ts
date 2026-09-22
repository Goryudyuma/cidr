import type { Envelope, WorkerRequest, WorkerResponse } from './types';
import { decodeShare, encodeShare, ShareError, type ShareCompression } from './share';

type CodecResult = { data: Uint8Array; codec?: 'g' | 'b'; error?: never } | {
  data?: never; codec?: never; error: { code: ShareError['code']; field: string; message: string };
};

interface GoRuntime {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}
const scope = globalThis as unknown as DedicatedWorkerGlobalScope & {
  Go: new () => GoRuntime;
  cidrEvaluate: (json: string) => string;
  cidrShareCompress: (data: Uint8Array) => CodecResult;
  cidrShareDecompress: (codec: 'g' | 'b', data: Uint8Array) => CodecResult;
  cidrReady: () => void;
};
let initialized = false;
let starting = false;
const compression: ShareCompression = {
  compress(data) {
    const result = scope.cidrShareCompress(data);
    if (result.error) throw new ShareError(result.error.code, result.error.message, result.error.field);
    if (!result.codec) throw new ShareError('invalid');
    return { codec: result.codec, data: result.data };
  },
  decompress(codec, data) {
    const result = scope.cidrShareDecompress(codec, data);
    if (result.error) throw new ShareError(result.error.code, result.error.message, result.error.field);
    return result.data;
  },
};
function send(message: WorkerResponse): void { scope.postMessage(message); }
function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error) ?? String(error); }
  catch { return String(error); }
}
function fatal(error: unknown): void {
  initialized = false;
  send({ type: 'fatal', error: {
    code: 'wasm_unavailable', field: 'worker',
    message: `Unable to initialize or run Wasm: ${errorDetail(error)}`,
  } });
}

async function initialize(wasmURL: string, runtimeURL: string): Promise<void> {
  try {
    // The Go runtime is an IIFE and works as a module side effect inside a module Worker.
    await import(/* @vite-ignore */ runtimeURL);
    const go = new scope.Go();
    const response = await fetch(wasmURL);
    if (!response.ok) throw new Error(`Wasm HTTP ${response.status}`);
    // arrayBuffer also supports static hosts that serve .wasm as application/octet-stream.
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject);
    const ready = new Promise<void>((resolve) => { scope.cidrReady = resolve; });
    void go.run(instance).then(() => fatal(new Error('The Go runtime exited.')), fatal);
    await ready;
    if (typeof scope.cidrEvaluate !== 'function') throw new Error('The calculation function was not registered.');
    if (typeof scope.cidrShareCompress !== 'function' || typeof scope.cidrShareDecompress !== 'function') {
      throw new Error('The sharing compression functions were not registered.');
    }
    initialized = true;
    send({ type: 'ready' });
  } catch (error) { fatal(error); }
}

async function share(data: Extract<WorkerRequest, { type: 'share-encode' | 'share-decode' }>): Promise<void> {
  try {
    if (!initialized) throw new ShareError('invalid', 'Wasm has not finished loading.');
    const result = data.type === 'share-encode'
      ? { kind: 'encode' as const, hash: await encodeShare(data.state, compression) }
      : { kind: 'decode' as const, state: await decodeShare(data.hash, compression) };
    send({ type: 'share-result', id: data.id, result });
  } catch (error) {
    const failure = error instanceof ShareError ? error : new ShareError('invalid');
    send({ type: 'share-result', id: data.id, error: { code: failure.code, field: failure.field, message: failure.message } });
  }
}

scope.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  if (data.type === 'init') {
    if (starting) return;
    starting = true;
    void initialize(data.wasmURL, data.runtimeURL);
    return;
  }
  if ((data.type === 'share-encode' || data.type === 'share-decode') && Number.isSafeInteger(data.id)) {
    void share(data);
    return;
  }
  if (data.type !== 'evaluate' || !Number.isSafeInteger(data.id)) return;
  if (!initialized) {
    send({ type: 'result', id: data.id, error: { code: 'not_ready', message: 'Wasm has not finished loading', field: 'worker' } });
    return;
  }
  try {
    const envelope = JSON.parse(scope.cidrEvaluate(JSON.stringify(data.request))) as Envelope;
    send({ type: 'result', id: data.id, ...envelope });
  } catch (error) { fatal(error); }
};
