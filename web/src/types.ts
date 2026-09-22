import type { SharedState } from './share';

export type Family = 'ipv4' | 'ipv6';
export interface Operation { op: 'add' | 'remove'; value: string }
export interface Request { initial?: string[]; operations?: Operation[] }
export interface IPRange { family: Family; start: string; end: string }
export interface Result {
  cidrs: string[];
  ranges: IPRange[];
  addressCount: Record<Family, string>;
}
export interface EvaluationError { code: string; message: string; field: string }
export type Envelope = { result: Result; error?: never } | { error: EvaluationError; result?: never };
export type WorkerRequest =
  | { type: 'init'; wasmURL: string; runtimeURL: string }
  | { type: 'evaluate'; id: number; request: Request }
  | { type: 'share-encode'; id: number; state: SharedState }
  | { type: 'share-decode'; id: number; hash: string };
export type ShareReply = { kind: 'encode'; hash: string } | { kind: 'decode'; state: SharedState | null };
export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'fatal'; error: EvaluationError }
  | ({ type: 'share-result'; id: number } & ({ result: ShareReply; error?: never } | { error: EvaluationError; result?: never }))
  | ({ type: 'result'; id: number } & Envelope);
