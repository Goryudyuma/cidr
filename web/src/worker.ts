import type { Envelope, WorkerRequest, WorkerResponse } from './types';

interface GoRuntime {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}
const scope = globalThis as unknown as DedicatedWorkerGlobalScope & {
  Go: new () => GoRuntime;
  cidrEvaluate: (json: string) => string;
  cidrReady: () => void;
};
let initialized = false;
let starting = false;
function send(message: WorkerResponse): void { scope.postMessage(message); }
function fatal(error: unknown): void {
  initialized = false;
  send({ type: 'fatal', error: {
    code: 'wasm_unavailable', field: 'worker',
    message: `Wasmを初期化・実行できませんでした: ${error instanceof Error ? error.message : String(error)}`,
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
    void go.run(instance).then(() => fatal(new Error('Goランタイムが終了しました。')), fatal);
    await ready;
    if (typeof scope.cidrEvaluate !== 'function') throw new Error('計算関数が登録されていません。');
    initialized = true;
    send({ type: 'ready' });
  } catch (error) { fatal(error); }
}

scope.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  if (data.type === 'init') {
    if (starting) return;
    starting = true;
    void initialize(data.wasmURL, data.runtimeURL);
    return;
  }
  if (data.type !== 'evaluate' || !Number.isSafeInteger(data.id)) return;
  if (!initialized) {
    send({ type: 'result', id: data.id, error: { code: 'not_ready', message: 'Wasmの読み込みが完了していません。', field: 'worker' } });
    return;
  }
  try {
    const envelope = JSON.parse(scope.cidrEvaluate(JSON.stringify(data.request))) as Envelope;
    send({ type: 'result', id: data.id, ...envelope });
  } catch (error) { fatal(error); }
};
