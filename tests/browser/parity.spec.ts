import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { Envelope, Request } from '../../web/src/types';

const fixtures = JSON.parse(readFileSync('testdata/evaluate.json', 'utf8')) as {
  name: string; request: Request; result?: unknown; error?: { code: string; field: string };
}[];
const workerFile = readdirSync('web/dist/assets').find((name) => /^worker-.*\.js$/.test(name));
if (!workerFile) throw new Error('Build the production web app before browser tests.');
let native: Envelope[];
test.beforeAll(() => {
  native = JSON.parse(execFileSync('go', ['run', './tests/native', 'testdata/evaluate.json'], { encoding: 'utf8' }));
});

test('shared fixtures agree across native Go, live HTTP, and production Worker/Wasm', async ({ page, request }) => {
  await page.goto('/');
  const wasm = await page.evaluate(async ({ fixtures, workerFile }) => {
    const worker = new Worker(`/assets/${workerFile}`, { type: 'module' });
    const messages = new Map<number, (response: unknown) => void>();
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    worker.onerror = (event) => rejectReady(new Error(event.message));
    worker.onmessage = ({ data }) => {
      if (data.type === 'ready') resolveReady();
      else if (data.type === 'fatal') rejectReady(new Error(data.error.message));
      else if (data.type === 'result') messages.get(data.id)?.(data);
    };
    worker.postMessage({ type: 'init', wasmURL: `${location.origin}/wasm/core.wasm`, runtimeURL: `${location.origin}/wasm/wasm_exec.js` });
    await ready;
    // Queue all IDs before collecting results, exercising actual Worker message correlation.
    const results = await Promise.all(fixtures.map((fixture, id) => new Promise<Record<string, unknown>>((resolve) => {
      messages.set(id, (response) => resolve(response as Record<string, unknown>));
      worker.postMessage({ type: 'evaluate', id, request: fixture.request });
    })));
    worker.terminate();
    return results.map(({ type: _type, id: _id, ...envelope }) => envelope);
  }, { fixtures, workerFile });

  for (const [index, fixture] of fixtures.entries()) {
    expect(wasm[index], `${fixture.name}: wasm/native`).toEqual(native[index]);
    if (fixture.result) expect(native[index]).toEqual({ result: fixture.result });
    else expect(native[index]).toMatchObject({ error: fixture.error });
    const response = await request.post('http://127.0.0.1:18080/api/evaluate', { data: fixture.request });
    expect(response.status(), fixture.name).toBe(fixture.error ? 400 : 200);
    expect(await response.json(), fixture.name).toEqual(fixture.error ? native[index] : native[index].result);
  }
});

test('HTTP bounds malformed, excessive, and deeply nested requests', async ({ request }) => {
  for (const data of [
    '{', '{} {}', 'null', '{"initial":[],"initial":[]}',
    JSON.stringify({ initial: Array(100001).fill('192.0.2.1') }),
    JSON.stringify({ operations: Array(100001).fill({ op: 'add', value: '::1' }) }),
    JSON.stringify({ initial: ['1'.repeat(129)] }),
    JSON.stringify({ initial: [' '.repeat(32 * 1_048_576)] }),
    `{"initial":${'['.repeat(10_001)}${']'.repeat(10_001)}}`,
  ]) {
    const response = await request.post('http://127.0.0.1:18080/api/evaluate', {
      data, headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toEqual(expect.objectContaining({ code: expect.any(String), message: expect.any(String), field: expect.any(String) }));
    expect(body).not.toHaveProperty('cidrs');
  }
});
