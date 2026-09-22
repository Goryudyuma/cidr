import type { EvaluationError, Request, Result, WorkerRequest, WorkerResponse } from './types';

export class EngineError extends Error {
  readonly code: string;
  readonly field: string;
  constructor(error: EvaluationError) {
    super(error.message);
    this.name = 'EngineError';
    this.code = error.code;
    this.field = error.field;
  }
}

/** Each instance owns one Worker. IDs correlate replies; callers choose which result to display. */
export class Engine {
  readonly ready: Promise<void>;
  private worker?: Worker;
  private nextID = 0;
  private pending = new Map<number, { resolve: (result: Result) => void; reject: (error: Error) => void }>();
  private failure?: Error;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private timer: ReturnType<typeof setTimeout>;

  constructor() {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A caller may attach an init-error handler after constructing the UI.
    void this.ready.catch(() => {});
    this.timer = setTimeout(() => this.fail(new Error('Wasmの初期化がタイムアウトしました。再読み込みしてください。')), 30_000);
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      if (this.failure) return;
      if (data.type === 'ready') {
        clearTimeout(this.timer);
        this.resolveReady();
      } else if (data.type === 'fatal') {
        this.fail(new EngineError(data.error));
      } else {
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id);
        if (data.error) pending.reject(new EngineError(data.error));
        else pending.resolve(data.result);
      }
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.fail(new Error(`計算Workerを起動できませんでした: ${event.message}`));
    };
    this.worker.onmessageerror = () => this.fail(new Error('計算Workerからの応答を読み取れませんでした。'));
    try {
      this.send({
        type: 'init',
        wasmURL: new URL(`${import.meta.env.BASE_URL}wasm/core.wasm`, window.location.href).href,
        runtimeURL: new URL(`${import.meta.env.BASE_URL}wasm/wasm_exec.js`, window.location.href).href,
      });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async evaluate(request: Request): Promise<Result> {
    await this.ready;
    if (this.failure) throw this.failure;
    if (this.pending.size >= 64) throw new Error('計算が混み合っています。完了後にもう一度お試しください。');
    const id = ++this.nextID;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.send({ type: 'evaluate', id, request }); }
      catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  dispose(): void { this.fail(new Error('計算Workerを終了しました。')); }

  private send(message: WorkerRequest): void {
    if (!this.worker) throw this.failure ?? new Error('計算Workerを利用できません。');
    this.worker.postMessage(message);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    clearTimeout(this.timer);
    this.rejectReady(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.worker?.terminate();
  }
}
