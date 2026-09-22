import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const target = new URL(process.argv[2] ?? '');
if (!['https:', 'http:'].includes(target.protocol)) throw new Error('Usage: node scripts/smoke-deployment.mjs <URL>');
const root = new URL('../', import.meta.url);
const fixtures = JSON.parse(await readFile(new URL('testdata/evaluate.json', root), 'utf8'));
const workerFile = (await readdir(new URL('web/dist/assets/', root))).find((name) => /^worker-.*\.js$/.test(name));
if (!workerFile) throw new Error('Run npm run build before checking a deployment.');

// Verify that production serves the exact matching Go module and runtime.
for (const path of ['wasm/core.wasm', 'wasm/wasm_exec.js']) {
  const response = await fetch(new URL(path, target));
  assert.equal(response.status, 200, path);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL(`web/dist/${path}`, root)), path);
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(target.href, { waitUntil: 'networkidle', timeout: 60_000 });
  await expect(page.locator('#engine-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('#result-status')).toContainText('計算完了');

  const responses = await page.evaluate(async ({ fixtures, workerFile }) => {
    const worker = new Worker(new URL(`assets/${workerFile}`, location.href), { type: 'module' });
    try {
      return await new Promise((resolve, reject) => {
        const replies = new Map();
        const timer = setTimeout(() => reject(new Error('Production Worker timed out.')), 30_000);
        const fail = (message) => { clearTimeout(timer); reject(new Error(message)); };
        worker.onerror = (event) => fail(event.message);
        worker.onmessage = ({ data }) => {
          if (data.type === 'fatal') { fail(data.error.message); return; }
          if (data.type === 'ready') {
            fixtures.forEach((fixture, id) => worker.postMessage({ type: 'evaluate', id, request: fixture.request }));
          } else if (data.type === 'result') {
            replies.set(data.id, data.error ? { error: data.error } : { result: data.result });
            if (replies.size === fixtures.length) {
              clearTimeout(timer);
              resolve(fixtures.map((_, id) => replies.get(id)));
            }
          }
        };
        worker.postMessage({ type: 'init',
          wasmURL: new URL('wasm/core.wasm', location.href).href,
          runtimeURL: new URL('wasm/wasm_exec.js', location.href).href,
        });
      });
    } finally { worker.terminate(); }
  }, { fixtures, workerFile });

  fixtures.forEach((fixture, index) => {
    if (fixture.error) {
      assert.equal(responses[index].error?.code, fixture.error.code, fixture.name);
      assert.equal(responses[index].error?.field, fixture.error.field, fixture.name);
    } else assert.deepEqual(responses[index].result, fixture.result, fixture.name);
  });
  assert.equal(requests.some((url) => new URL(url).pathname.startsWith('/api/')), false);
  requests.length = 0;
  await context.setOffline(true);
  await page.locator('#load-example').click();
  await expect(page.locator('#count-ipv4')).toHaveText('5');
  await expect(page.locator('#cidr-list code')).toHaveText(['192.0.2.0/31', '192.0.2.2/32', '192.0.2.6/31']);
  await page.locator('#operation-input').fill('192.0.2.3');
  await page.locator('#add-operation').click();
  await expect(page.locator('#count-ipv4')).toHaveText('6');
  assert.deepEqual(requests, [], 'Offline calculation must not make network requests.');
  assert.deepEqual(errors, [], 'Browser runtime errors.');
  await page.screenshot({ path: fileURLToPath(new URL('test-results/production.png', root)), fullPage: true });
  console.log(JSON.stringify({ url: target.href, fixtures: fixtures.length, matchingWasmRuntime: true, offlineEditing: true, browserErrors: errors }, null, 2));
} finally { await browser.close(); }
