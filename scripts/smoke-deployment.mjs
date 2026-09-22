import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const target = new URL(process.argv[2] ?? '');
if (!['https:', 'http:'].includes(target.protocol)) throw new Error('Usage: node scripts/smoke-deployment.mjs <URL>');
// Accept either language's document URL. Both languages share the deployment
// directory's Worker/Wasm, even for /en/ or a deployment below a subdirectory.
const deployment = new URL(target);
deployment.search = '';
deployment.hash = '';
deployment.pathname = deployment.pathname.replace(/\/en(?:\/index\.html)?\/?$/, '/')
  .replace(/\/index\.html$/, '/').replace(/\/?$/, '/');
const root = new URL('../', import.meta.url);
const fixtures = JSON.parse(await readFile(new URL('testdata/evaluate.json', root), 'utf8'));
const workerFile = (await readdir(new URL('web/dist/assets/', root))).find((name) => /^worker-.*\.js$/.test(name));
if (!workerFile) throw new Error('Run npm run build before checking a deployment.');

// Verify that production serves the exact matching Go module and runtime.
for (const path of ['wasm/core.wasm', 'wasm/wasm_exec.js']) {
  const response = await fetch(new URL(path, deployment), { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, path);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL(`web/dist/${path}`, root)), path);
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: deployment.origin });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(deployment.href, { waitUntil: 'networkidle', timeout: 60_000 });
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.locator('#engine-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('#result-status')).toContainText('計算完了');

  const responses = await page.evaluate(async ({ fixtures, workerFile, deploymentURL }) => {
    const worker = new Worker(new URL(`assets/${workerFile}`, deploymentURL), { type: 'module' });
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
          wasmURL: new URL('wasm/core.wasm', deploymentURL).href,
          runtimeURL: new URL('wasm/wasm_exec.js', deploymentURL).href,
        });
      });
    } finally { worker.terminate(); }
  }, { fixtures, workerFile, deploymentURL: deployment.href });

  fixtures.forEach((fixture, index) => {
    if (fixture.error) {
      assert.equal(responses[index].error?.code, fixture.error.code, fixture.name);
      assert.equal(responses[index].error?.field, fixture.error.field, fixture.name);
    } else assert.deepEqual(responses[index].result, fixture.result, fixture.name);
  });
  // This is a real document navigation, so /en/ must work as the first visit too.
  const english = new URL('en/', deployment);
  await page.goto(english.href, { waitUntil: 'networkidle', timeout: 60_000 });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#engine-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('#result-status')).toContainText('Calculation complete');
  assert.equal(requests.some((url) => /\/api\//.test(new URL(url).pathname)), false);
  requests.length = 0;
  await context.setOffline(true);
  await page.locator('#load-example').click();
  await expect(page.locator('#count-ipv4')).toHaveText('5');
  await expect(page.locator('#cidr-list code')).toHaveText(['192.0.2.0/31', '192.0.2.2/32', '192.0.2.6/31']);
  await page.locator('#operation-input').fill('192.0.2.3');
  await page.locator('#add-operation').click();
  await expect(page.locator('#count-ipv4')).toHaveText('6');
  const appliedInitial = await page.locator('#initial-input').inputValue();
  const draftInitial = `${appliedInitial}\n203.0.113.9`;
  await page.locator('#initial-input').fill(draftInitial);
  await page.locator('#operation-input').fill('2001:db8::1');
  await page.locator('#zoom-input').fill('192.0.2.0/24');
  const operationCount = await page.locator('#operation-count').textContent();
  const cidrs = await page.locator('#cidr-list code').allTextContents();

  for (const locale of ['ja', 'en']) {
    await page.locator(`#language-${locale}`).click();
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    assert.equal(new URL(page.url()).pathname, locale === 'en' ? english.pathname : deployment.pathname);
    await expect(page.locator('#initial-input')).toHaveValue(draftInitial);
    await expect(page.locator('#operation-input')).toHaveValue('2001:db8::1');
    await expect(page.locator('#zoom-input')).toHaveValue('192.0.2.0/24');
    await expect(page.locator('#operation-count')).toHaveText(operationCount);
    await expect(page.locator('#count-ipv4')).toHaveText('6');
    await expect(page.locator('#cidr-list code')).toHaveText(cidrs);
    await page.screenshot({ path: fileURLToPath(new URL(`test-results/production-${locale}.png`, root)), fullPage: true });
  }
  // Existing state remains usable after switching languages while offline.
  await page.locator('#initial-input').fill(appliedInitial);
  await page.locator('#add-operation').click();
  await expect(page.locator('#count-ipv4')).toHaveText('6');
  await expect(page.locator('#count-ipv6')).toHaveText('1');
  await page.locator('#zoom-submit').click();
  await expect(page.locator('#plot-ipv4 .viewport-label')).toHaveText('192.0.2.0/24');
  await page.locator('#initial-input').fill(draftInitial);
  await page.locator('#operation-input').fill('203.0.113.77');
  await page.locator('#zoom-input').fill('2001:db8::/120');
  await page.locator('#tab-ranges').click();
  const sharedCIDRs = await page.locator('#cidr-list code').allTextContents();
  const sharedHistory = await page.locator('#operation-history li').allTextContents();
  await page.locator('#copy-share').click();
  await expect(page.locator('#share-status')).toContainText('Share link copied');
  const shareLink = await page.evaluate(() => navigator.clipboard.readText());
  const sharedURL = new URL(shareLink);
  assert.equal(sharedURL.origin, deployment.origin);
  assert.equal(sharedURL.pathname, english.pathname);
  assert.match(sharedURL.hash, /^#s=1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(requests, [], 'Offline calculation must not make network requests.');

  // Use a fresh, online browser context: restoration must load its own real
  // Worker and Wasm instead of relying on the source page's in-memory state.
  const restoreContext = await browser.newContext();
  try {
    const restoredRequests = [];
    restoreContext.on('request', (request) => {
      requests.push(request.url());
      restoredRequests.push({ url: request.url(), referer: request.headers().referer });
    });
    const restored = await restoreContext.newPage();
    restored.on('pageerror', (error) => errors.push(error.message));
    await restored.goto(shareLink, { waitUntil: 'networkidle', timeout: 60_000 });
    await expect(restored.locator('#engine-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await expect(restored.locator('#share-status')).toHaveText('Shared contents restored.');
    await expect(restored.locator('html')).toHaveAttribute('lang', 'en');
    await expect(restored.locator('#count-ipv4')).toHaveText('6');
    await expect(restored.locator('#count-ipv6')).toHaveText('1');
    await expect(restored.locator('#cidr-list code')).toHaveText(sharedCIDRs);
    await expect(restored.locator('#operation-history li')).toHaveText(sharedHistory);
    await expect(restored.locator('#initial-input')).toHaveValue(draftInitial);
    await expect(restored.locator('#operation-input')).toHaveValue('203.0.113.77');
    await expect(restored.locator('#zoom-input')).toHaveValue('2001:db8::/120');
    await expect(restored.locator('#plot-ipv4 .viewport-label')).toHaveText('192.0.2.0/24');
    await expect(restored.locator('#tab-ranges')).toHaveAttribute('aria-selected', 'true');
    await expect(restored.locator('#draft-status')).not.toBeEmpty();
    await expect(restored.locator('#add-operation')).toBeDisabled();
    assert.ok(restoredRequests.some(({ url }) => new URL(url).pathname === new URL('wasm/core.wasm', deployment).pathname),
      'The shared page must load the actual Go Wasm module.');
    assert.ok(restoredRequests.some(({ url }) => new URL(url).pathname === new URL(`assets/${workerFile}`, deployment).pathname),
      'The shared page must load the compiled calculation Worker.');
    for (const request of restoredRequests) {
      assert.equal(new URL(request.url).hash, '', 'A shared fragment must not enter HTTP requests.');
      assert.equal(request.referer ? new URL(request.referer).hash : '', '', 'A shared fragment must not enter Referer headers.');
    }
  } finally { await restoreContext.close(); }
  assert.equal(requests.some((url) => /\/api\//.test(new URL(url).pathname)), false, 'Sharing must not use a calculation HTTP API.');
  assert.deepEqual(errors, [], 'Browser runtime errors.');
  console.log(JSON.stringify({ url: deployment.href, fixtures: fixtures.length, matchingWasmRuntime: true,
    englishDirectAccess: true, offlineEditing: true, offlineLanguageSwitch: true, preservedEdits: true,
    offlineShareLink: true, sharedStateRestored: true,
    screenshots: ['test-results/production-ja.png', 'test-results/production-en.png'], browserErrors: errors }, null, 2));
} finally { await browser.close(); }
