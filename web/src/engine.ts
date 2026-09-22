import type { EvaluationError, Request, Result, WorkerRequest, WorkerResponse } from './types';
import { assetURL, getLocale } from './i18n';

const workerMessages: Record<string, { en: string; ja: string }> = {
  wasm_unavailable: { en: 'Unable to initialize or run Wasm', ja: 'Wasmを初期化・実行できませんでした' },
  not_ready: { en: 'Wasm has not finished loading', ja: 'Wasmの読み込みが完了していません' },
  wasm_init_timeout: { en: 'Wasm initialization timed out. Reload the page', ja: 'Wasmの初期化がタイムアウトしました。再読み込みしてください' },
  worker_start_failed: { en: 'Unable to start the calculation Worker', ja: '計算Workerを起動できませんでした' },
  worker_failed: { en: 'The calculation Worker failed', ja: '計算Workerでエラーが発生しました' },
  worker_message_error: { en: 'Unable to read the calculation Worker response', ja: '計算Workerからの応答を読み取れませんでした' },
  worker_send_failed: { en: 'Unable to send the request to the calculation Worker', ja: '計算Workerにリクエストを送信できませんでした' },
  worker_busy: { en: 'Too many calculations are pending. Try again after they finish', ja: '計算が混み合っています。完了後にもう一度お試しください' },
  worker_disposed: { en: 'The calculation Worker was stopped', ja: '計算Workerを終了しました' },
  worker_unavailable: { en: 'The calculation Worker is unavailable', ja: '計算Workerを利用できません' },
};

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error) ?? String(error); }
  catch { return String(error); }
}

export class EngineError extends Error {
  readonly code: string;
  readonly field: string;
  constructor(error: EvaluationError, cause?: unknown) {
    super(error.message, { cause });
    this.name = 'EngineError';
    this.code = error.code;
    this.field = error.field;
  }
}

function workerError(code: string, cause?: unknown): EngineError {
  const message = workerMessages[code].en;
  return new EngineError({ code, field: 'worker', message: cause === undefined ? message : `${message}: ${errorDetail(cause)}` }, cause);
}

/** Format at display time so existing errors follow an offline language change. */
export function formatEngineError(error: unknown): string {
  if (!(error instanceof Error)) return errorDetail(error);
  const detail = error as Error & { code?: string; field?: string };
  let message = detail.message;
  const translation = detail.field === 'worker' && detail.code && Object.hasOwn(workerMessages, detail.code)
    ? workerMessages[detail.code] : undefined;
  if (translation) {
    const localized = translation[getLocale()];
    if (message === translation.en) message = localized;
    else if (message.startsWith(`${translation.en}: `)) message = `${localized}${message.slice(translation.en.length)}`;
    else message = `${localized}: ${message}`;
  }
  return `${message}${detail.field ? ` · ${detail.field}` : ''}${detail.code ? ` [${detail.code}]` : ''}`;
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
    this.timer = setTimeout(() => this.fail(workerError('wasm_init_timeout')), 30_000);
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      this.fail(workerError('worker_start_failed', error));
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
      this.fail(workerError('worker_failed', event.message));
    };
    this.worker.onmessageerror = () => this.fail(workerError('worker_message_error'));
    try {
      this.send({
        type: 'init',
        wasmURL: assetURL('wasm/core.wasm').href,
        runtimeURL: assetURL('wasm/wasm_exec.js').href,
      });
    } catch (error) {
      this.fail(error instanceof EngineError ? error : workerError('worker_send_failed', error));
    }
  }

  async evaluate(request: Request): Promise<Result> {
    await this.ready;
    if (this.failure) throw this.failure;
    if (this.pending.size >= 64) throw workerError('worker_busy');
    const id = ++this.nextID;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.send({ type: 'evaluate', id, request }); }
      catch (error) {
        this.pending.delete(id);
        reject(error instanceof EngineError ? error : workerError('worker_send_failed', error));
      }
    });
  }

  dispose(): void { this.fail(workerError('worker_disposed')); }

  private send(message: WorkerRequest): void {
    if (!this.worker) throw this.failure ?? workerError('worker_unavailable');
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
