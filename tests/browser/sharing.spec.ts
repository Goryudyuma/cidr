import { expect, test, type Page } from '@playwright/test';
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import type { SharedState } from '../../web/src/share';

async function ready(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await expect(page.locator('#engine-status')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#result-status')).toContainText(path.startsWith('/en') ? 'Calculation complete' : '計算完了');
}

async function copyShareLink(page: Page): Promise<string> {
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.locator('#copy-share').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^https?:\/\/[^\s]+#s=2\.[gb]\.[A-Za-z0-9_-]+$/);
  return page.evaluate(() => navigator.clipboard.readText());
}

function validState(): SharedState {
  return {
    version: 1,
    request: { initial: ['192.0.2.0/24'], operations: [] },
    inputs: { initial: '192.0.2.0/24', operation: '', zoom: '' },
    view: { mode: 'fit', viewports: {}, relatedPage: 0 },
    output: { tab: 'cidrs', cidrPage: 0, rangePage: 0, historyPage: 0 },
  };
}

type Draft = string | [number, number, string];

function wireState(state: SharedState = validState(), draft: Draft = state.inputs.initial) {
  return {
    version: 2,
    initial: state.request.initial,
    operations: state.request.operations.map(({ op, value }) => [op === 'add' ? 0 : 1, value]),
    inputs: [draft, state.inputs.operation, state.inputs.zoom],
    view: state.view,
    output: state.output,
  };
}

function encodeWireHash(wire: unknown, codec: 'g' | 'b' = 'g'): string {
  const bytes = Buffer.from(JSON.stringify(wire));
  const compressed = codec === 'g' ? gzipSync(bytes) : brotliCompressSync(bytes);
  return `#s=2.${codec}.${compressed.toString('base64url')}`;
}

function encodeHash(_page: Page, state: SharedState): string {
  return encodeWireHash(wireState(state));
}

function legacyHash(state: SharedState): string {
  return '#s=1.' + gzipSync(JSON.stringify(state)).toString('base64url');
}

function decodeWire(link: string) {
  const match = /^#s=2\.([gb])\.([A-Za-z0-9_-]+)$/.exec(new URL(link).hash);
  if (!match) throw new Error('Expected a version 2 share link');
  const compressed = Buffer.from(match[2], 'base64url');
  return JSON.parse((match[1] === 'g' ? gunzipSync(compressed) : brotliDecompressSync(compressed)).toString('utf8'));
}

// Independent wire decoding verifies losslessness without importing the codec.
function decodeLink(_page: Page, link: string): SharedState {
  const wire = decodeWire(link);
  const base = wire.initial.join('\n');
  const draft: Draft = wire.inputs[0];
  return {
    version: 1,
    request: { initial: wire.initial, operations: wire.operations.map(([op, value]: [number, string]) => ({ op: op === 0 ? 'add' : 'remove', value })) },
    inputs: {
      initial: typeof draft === 'string' ? draft : base.slice(0, draft[0]) + draft[2] + base.slice(base.length - draft[1]),
      operation: wire.inputs[1],
      zoom: wire.inputs[2],
    },
    view: wire.view,
    output: wire.output,
  };
}

async function editorSnapshot(page: Page) {
  return page.evaluate(() => {
    const texts = (selector: string) => Array.from(document.querySelectorAll(selector), (element) => element.textContent);
    const value = (selector: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!.value;
    return {
      inputs: { initial: value('#initial-input'), operation: value('#operation-input'), zoom: value('#zoom-input') },
      counts: texts('#count-ipv4, #count-ipv6, #cidr-count, #operation-count'),
      cidrs: texts('#cidr-list code'),
      ranges: texts('#range-list code'),
      history: texts('#operation-history li'),
      pages: texts('#cidr-pagination span, #range-pagination span, #history-pagination span'),
      bounds: texts('#range-detail .detail-bounds dd'),
      related: texts('#range-detail .related-cidrs code'),
      axes: texts('.plot-axis'),
      viewLabels: texts('.viewport-label'),
      selected: Array.from(document.querySelectorAll('.range-band.selected'), (element) => element.getAttribute('data-range-index')),
      ipv6Marks: Array.from(document.querySelectorAll('#plot-ipv6 .range-band'), (element) => ({ x: element.getAttribute('x'), width: element.getAttribute('width') })),
      tab: document.querySelector('[role="tab"][aria-selected="true"]')!.id,
      viewButtons: ['#view-fit', '#view-all'].map((selector) => document.querySelector(selector)!.getAttribute('aria-pressed')),
    };
  });
}

test('a copied link restores applied edits, drafts, IPv6 precision, selection and every result page', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ready(page);
  const initial = [
    ...Array.from({ length: 85 }, (_, index) => `10.0.${index}.1`),
    '192.0.2.0/30',
    'ffff:ffff:ffff:ffff:ffff:ffff:ffff:fff1',
    'ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe',
  ];
  await page.locator('#initial-input').fill(initial.join('\n'));
  await page.locator('#apply-initial').click();
  await expect(page.locator('#count-ipv4')).toHaveText('89');
  const operations = Array.from({ length: 11 }, (_, index) => ({ op: index % 2 === 0 ? 'remove' : 'add', value: '192.0.2.1' }));
  for (const [index, operation] of operations.entries()) {
    await page.locator('#operation-input').fill(operation.value);
    await page.locator(`#${operation.op}-operation`).click();
    await expect(page.locator('#operation-count')).toHaveText(String(index + 1));
  }
  await expect(page.locator('#count-ipv4')).toHaveText('88');
  await expect(page.locator('#cidr-count')).toHaveText('89');
  await page.locator('#history-pagination button').first().click();
  await page.locator('#cidr-pagination button').last().click();
  await expect(page.locator('#cidr-list code').first()).toHaveText('10.0.40.1/32');
  await page.locator('#tab-ranges').click();
  await page.locator('#range-pagination button').last().click();
  await page.locator('#range-pagination button').last().click();
  await page.locator('#view-all').click();
  await page.locator('#range-list button').last().click();
  const zoom = 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:fff0/124';
  await page.locator('#zoom-input').fill(zoom);
  await page.locator('#zoom-submit').click();
  await expect(page.locator('#plot-ipv6 .viewport-label')).toHaveText(zoom);
  await expect(page.locator('#plot-ipv6 .range-band')).toHaveCount(2);
  const positions = await page.locator('#plot-ipv6 .range-band').evaluateAll((marks) => marks.map((mark) => Number(mark.getAttribute('x'))));
  expect(positions[1] - positions[0]).toBeGreaterThan(700);
  await page.locator('#initial-input').fill(`${initial.join('\n')}\nnot-an-applied-IP`);
  await page.locator('#operation-input').fill('203.0.113.77');
  await page.locator('#zoom-input').fill('2001:db8::/120');
  await expect(page.locator('#draft-status')).not.toBeEmpty();

  const link = await copyShareLink(page);
  const saved = await decodeLink(page, link);
  expect(saved.request).toEqual({ initial, operations });
  expect(saved.inputs.initial).toContain('not-an-applied-IP');
  expect(saved.view.mode).toBe('all');
  expect(saved.view.viewports.ipv6.start).toBe(((1n << 128n) - 16n).toString());
  expect(saved.view.viewports.ipv6.end).toBe(((1n << 128n) - 1n).toString());
  expect(saved.output).toEqual({ tab: 'ranges', cidrPage: 1, rangePage: 2, historyPage: 0 });
  const before = await editorSnapshot(page);
  const restored = await context.newPage();
  await restored.goto(link);
  await expect(restored.locator('#engine-status')).toHaveAttribute('data-state', 'ready');
  await expect(restored.locator('#share-status')).toHaveText('共有された内容を復元しました。');
  await expect(restored.locator('#operation-count')).toHaveText('11');
  await expect(restored.locator('#cidr-count')).toHaveText('89');
  await expect(restored.locator('#draft-status')).not.toBeEmpty();
  await expect(restored.locator('#add-operation')).toBeDisabled();
  expect(await editorSnapshot(restored)).toEqual(before);
});

test('an empty English set can be shared offline and its fragment never enters HTTP requests', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ready(page, '/en/');
  await page.locator('#reset-set').click();
  await expect(page.locator('#initial-input')).toHaveValue('');
  await expect(page.locator('#cidr-count')).toHaveText('0');
  const requests: { url: string; referer?: string }[] = [];
  context.on('request', (request) => requests.push({ url: request.url(), referer: request.headers().referer }));
  await context.setOffline(true);
  const link = await copyShareLink(page);
  expect(new URL(link).pathname).toBe('/en/');
  expect((await decodeLink(page, link)).request).toEqual({ initial: [], operations: [] });
  expect(requests).toEqual([]);
  await context.setOffline(false);

  const restored = await context.newPage();
  await restored.goto(link);
  await expect(restored.locator('#engine-status')).toHaveAttribute('data-state', 'ready');
  await expect(restored.locator('#share-status')).toHaveText('Shared contents restored.');
  await expect(restored.locator('html')).toHaveAttribute('lang', 'en');
  await expect(restored.locator('#cidr-count')).toHaveText('0');
  await expect(restored.locator('#initial-input')).toHaveValue('');
  const fragment = new URL(link).hash;
  await restored.locator('#language-ja').click();
  expect(new URL(restored.url()).hash).toBe(fragment);
  await restored.reload();
  await expect(restored.locator('#engine-status')).toHaveAttribute('data-state', 'ready');
  await expect(restored.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(restored.locator('#cidr-count')).toHaveText('0');
  await restored.locator('#language-en').click();
  expect(new URL(restored.url()).hash).toBe(fragment);
  await restored.reload();
  await expect(restored.locator('#engine-status')).toHaveAttribute('data-state', 'ready');
  await expect(restored.locator('#cidr-count')).toHaveText('0');
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(new URL(request.url).hash).toBe('');
    expect(request.url).not.toContain(fragment.slice('#s=2.g.'.length));
    if (request.referer) expect(new URL(request.referer).hash).toBe('');
  }
});

test('malformed, unknown, oversized and invalid shared states fail without partial restoration', async ({ page }) => {
  test.setTimeout(60_000);
  await ready(page);
  const wire = wireState();
  const invalidRequest = validState();
  invalidRequest.request.initial.push('not-an-IP');
  const cases = [
    { name: 'malformed base64', hash: '#s=2.g.***' },
    { name: 'retired version 1 with a formerly valid payload', hash: legacyHash(validState()) },
    { name: 'unknown envelope version', hash: '#s=99.g.AAAA' },
    { name: 'unknown codec', hash: '#s=2.x.AAAA' },
    { name: 'unknown wire version', hash: encodeWireHash({ ...wire, version: 3 }) },
    { name: 'unknown wire field', hash: encodeWireHash({ ...wire, unexpected: true }) },
    { name: 'unsafe page index', hash: encodeWireHash({ ...wire, output: { ...wire.output, cidrPage: Number.MAX_SAFE_INTEGER + 1 } }) },
    { name: 'negative draft prefix', hash: encodeWireHash({ ...wire, inputs: [[-1, 0, ''], '', ''] }) },
    { name: 'overlapping draft prefix and suffix', hash: encodeWireHash({ ...wire, inputs: [[wire.initial.join('\n').length, 1, ''], '', ''] }) },
    { name: 'fractional draft index', hash: encodeWireHash({ ...wire, inputs: [[0.5, 0, ''], '', ''] }) },
    { name: 'unsafe draft index', hash: encodeWireHash({ ...wire, inputs: [[Number.MAX_SAFE_INTEGER + 1, 0, ''], '', ''] }) },
    { name: 'malformed draft tuple', hash: encodeWireHash({ ...wire, inputs: [[0, 0, '', 'extra'], '', ''] }) },
    { name: 'unknown operation tag', hash: encodeWireHash({ ...wire, operations: [[2, '192.0.2.1']] }) },
    { name: 'malformed operation tuple', hash: encodeWireHash({ ...wire, operations: [[0, '192.0.2.1', 'extra']] }) },
    { name: 'incomplete inputs tuple', hash: encodeWireHash({ ...wire, inputs: ['draft', 'operation'] }) },
    { name: 'IPv6 coordinate exceeds its address space', hash: encodeWireHash({
      ...wire,
      view: { ...validState().view, viewports: { ipv6: { start: '0', end: (1n << 128n).toString(), label: { kind: 'custom', text: '::/0' } } } },
    }) },
    { name: 'oversized fragment', hash: '#s=2.g.' + 'A'.repeat(32768) },
    { name: 'wire expands beyond 8 MiB', hash: encodeWireHash({ ...wire, inputs: ['x'.repeat(8 * 1024 * 1024 + 1), '', ''] }), sizeError: true },
    { name: 'compact wire restores beyond 16 MiB', hash: encodeWireHash({ ...wire, operations: Array(660_000).fill([0, '::']) }), sizeError: true },
    { name: 'valid prefix followed by an invalid IP', hash: await encodeHash(page, invalidRequest) },
  ];
  for (const item of cases) {
    await test.step(item.name, async () => {
      await page.goto('about:blank');
      await page.goto(`/${item.hash}`);
      await expect(page.locator('#share-status')).toContainText(item.sizeError ? '展開・復元サイズ' : /共有リンクが正しく|未対応の共有リンク|サイズ上限|展開・復元サイズ/);
      await expect(page.locator('#engine-status')).toHaveAttribute('data-state', 'ready');
      await expect(page.locator('#cidr-count')).toHaveText('0');
      await expect(page.locator('#count-ipv4')).toHaveText('0');
      await expect(page.locator('#count-ipv6')).toHaveText('0');
      await expect(page.locator('#operation-count')).toHaveText('0');
      await expect(page.locator('#initial-input')).toHaveValue('');
    });
  }
});

test('valid large page indexes clamp to the restored result instead of leaving empty pages', async ({ page }) => {
  await ready(page);
  const initial = Array.from({ length: 85 }, (_, index) => `10.0.${index}.1`);
  const base = validState();
  const hash = await encodeHash(page, {
    ...base,
    request: { initial, operations: Array.from({ length: 11 }, () => ({ op: 'remove', value: '203.0.113.1' })) },
    inputs: { ...base.inputs, initial: initial.join('\n') },
    view: { ...base.view, selected: 0, relatedPage: Number.MAX_SAFE_INTEGER },
    output: { tab: 'ranges', cidrPage: Number.MAX_SAFE_INTEGER, rangePage: Number.MAX_SAFE_INTEGER, historyPage: Number.MAX_SAFE_INTEGER },
  });
  await page.goto('about:blank');
  await page.goto(`/${hash}`);
  await expect(page.locator('#share-status')).toHaveText('共有された内容を復元しました。');
  await expect(page.locator('#cidr-count')).toHaveText('85');
  await expect(page.locator('#cidr-pagination span')).toHaveText('81–85 / 85');
  await expect(page.locator('#range-pagination span')).toHaveText('81–85 / 85');
  await expect(page.locator('#history-pagination span')).toHaveText('11–11 / 11');
  await expect(page.locator('#cidr-list code').first()).toHaveText('10.0.80.1/32');
  await expect(page.locator('#range-list code').last()).toHaveText('10.0.84.1 → 10.0.84.1');
  await expect(page.locator('#operation-history .history-index')).toHaveText(['11']);
  await expect(page.locator('#range-detail .related-cidrs code')).toHaveText(['10.0.0.1/32']);
  await expect(page.locator('#tab-ranges')).toHaveAttribute('aria-selected', 'true');
});

test('a compressible draft larger than 1 MiB can be shared without changing the applied set', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ready(page);
  await page.locator('#load-example').click();
  await expect(page.locator('#count-ipv4')).toHaveText('5');
  const applied = await page.locator('#initial-input').inputValue();
  const draft = '🌱 x \n'.repeat(200_000);
  expect(Buffer.byteLength(draft)).toBeGreaterThan(1024 * 1024);
  await page.locator('#initial-input').evaluate((element, value) => {
    (element as HTMLTextAreaElement).value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, draft);
  const link = await copyShareLink(page);
  expect(decodeLink(page, link).inputs.initial).toBe(draft);
  expect(new URL(link).hash.length).toBeLessThanOrEqual(32768);
  await expect(page.locator('#share-fallback')).toBeHidden();
  await expect(page.locator('#count-ipv4')).toHaveText('5');
  await expect(page.locator('#operation-count')).toHaveText('2');
  await expect(page.locator('#copy-cidrs')).toBeEnabled();
  const restored = await context.newPage();
  await restored.goto(link);
  await expect(restored.locator('#share-status')).toHaveText('共有された内容を復元しました。');
  await expect(restored.locator('#initial-input')).toHaveValue(draft);
  await expect(restored.locator('#count-ipv4')).toHaveText('5');
  await page.locator('#initial-input').fill(applied);
  await page.locator('#operation-input').fill('192.0.2.3');
  await page.locator('#add-operation').click();
  await expect(page.locator('#count-ipv4')).toHaveText('6');
  await expect(page.locator('#cidr-list code')).toHaveText(['192.0.2.0/30', '192.0.2.6/31']);
});

test('editing during real Wasm initialization prevents an older shared state from replacing the draft', async ({ page }) => {
  await ready(page);
  const hash = await encodeHash(page, validState());
  await page.goto('about:blank');
  let release = () => {};
  let started = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const blocked = new Promise<void>((resolve) => { started = resolve; });
  await page.route('**/wasm/core.wasm', async (route) => {
    started();
    await gate;
    await route.continue();
  });
  try {
    await page.goto(`/${hash}`, { waitUntil: 'domcontentloaded' });
    await blocked;
    await page.locator('#initial-input').fill('203.0.113.9');
    release();
    await expect(page.locator('#engine-status')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('#initial-input')).toHaveValue('203.0.113.9');
    await expect(page.locator('#cidr-count')).toHaveText('0');
    await page.locator('#apply-initial').click();
    await expect(page.locator('#cidr-list code')).toHaveText(['203.0.113.9/32']);
    await page.locator('#zoom-input').fill('203.0.113.0/24');
    await page.locator('#zoom-submit').click();
    await expect(page.locator('#plot-ipv4 .viewport-label')).toHaveText('203.0.113.0/24');
    await expect(page.locator('#cidr-list code')).toHaveText(['203.0.113.9/32']);
  } finally {
    release();
  }
});

test('reset cancels a new shared state started by a real hashchange', async ({ page }) => {
  await ready(page);
  const first = await encodeHash(page, validState());
  const replacement = validState();
  replacement.request.initial = ['0.0.0.0/0'];
  replacement.inputs.initial = '0.0.0.0/0';
  const next = await encodeHash(page, replacement);
  await page.locator('#reset-set').click();
  await expect(page.locator('#cidr-count')).toHaveText('0');
  await page.evaluate((hash) => { location.hash = hash; }, first);
  await expect(page.locator('#share-status')).toHaveText('共有された内容を復元しました。');
  await expect(page.locator('#count-ipv4')).toHaveText('256');
  await expect(page.locator('#count-ipv6')).toHaveText('0');

  // The app's earlier hashchange listener starts decoding; reset runs in the
  // same event task before that asynchronous restoration can commit.
  await page.evaluate((hash) => new Promise<void>((resolve) => {
    window.addEventListener('hashchange', () => {
      document.querySelector<HTMLButtonElement>('#reset-set')!.click();
      resolve();
    }, { once: true });
    location.hash = hash;
  }), next);
  await expect(page.locator('#engine-status')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#initial-input')).toHaveValue('');
  await expect(page.locator('#cidr-count')).toHaveText('0');
  // A real Worker request forms a completion barrier after the reset.
  await page.locator('#zoom-input').fill('203.0.113.0/24');
  await page.locator('#zoom-submit').click();
  await expect(page.locator('#plot-ipv4 .viewport-label')).toHaveText('203.0.113.0/24');
  await expect(page.locator('#count-ipv4')).toHaveText('0');
  await expect(page.locator('#initial-input')).toHaveValue('');
  await expect(page.locator('#share-status')).toBeEmpty();
});

test('clipboard denial exposes a usable read-only share URL', async ({ page, context }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: async () => { throw new DOMException('Clipboard denied by the browser', 'NotAllowedError'); },
    });
  });
  await ready(page, '/en/');
  await page.locator('#load-example').click();
  await expect(page.locator('#count-ipv4')).toHaveText('5');
  await page.locator('#copy-share').click();
  await expect(page.locator('#share-fallback')).toBeVisible();
  await expect(page.locator('#share-link')).toHaveJSProperty('readOnly', true);
  await expect(page.locator('#share-status')).not.toBeEmpty();
  const link = await page.locator('#share-link').inputValue();
  expect(new URL(link).hash).toMatch(/^#s=2\.[gb]\.[A-Za-z0-9_-]+$/);
  const restored = await context.newPage();
  await restored.goto(link);
  await expect(restored.locator('#engine-status')).toHaveAttribute('data-state', 'ready');
  await expect(restored.locator('#cidr-list code')).toHaveText(['192.0.2.0/31', '192.0.2.2/32', '192.0.2.6/31']);
});

test('raw and differential drafts preserve spelling, duplicates, order, whitespace and Unicode', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const state = validState();
  state.request.initial = ['2001:0DB8:0:0:0:0:0:1/120', '192.0.2.7/24', '192.0.2.7/24', '2001:db8::1/120'];
  state.request.operations = [
    { op: 'remove', value: '192.0.2.1' },
    { op: 'add', value: '192.0.2.1' },
    { op: 'remove', value: '2001:DB8::1' },
    { op: 'add', value: '2001:DB8::1' },
    { op: 'remove', value: '192.0.2.2' },
  ];
  state.inputs.operation = ' \t203.0.113.9　';
  state.inputs.zoom = ' \t2001:DB8::/64🙂 ';
  const base = state.request.initial.join('\n');
  const cases: { name: string; draft: string; packed: Draft }[] = [
    { name: 'exact initial text', draft: base, packed: [base.length, 0, ''] },
    { name: 'small middle edit', draft: base.slice(0, 8) + '🦜 \n\t' + base.slice(8), packed: [8, base.length - 8, '🦜 \n\t'] },
    { name: 'raw unrelated draft', draft: ' \t未適用🙂 \n\n 末尾𠮷　\n', packed: ' \t未適用🙂 \n\n 末尾𠮷　\n' },
  ];
  for (const item of cases) {
    await test.step(item.name, async () => {
      const expected = { ...state, inputs: { ...state.inputs, initial: item.draft } };
      await page.goto('about:blank');
      await page.goto(`/${encodeWireHash(wireState(expected, item.packed))}`);
      await expect(page.locator('#share-status')).toHaveText('共有された内容を復元しました。');
      await expect(page.locator('#initial-input')).toHaveValue(item.draft);
      await expect(page.locator('#count-ipv4')).toHaveText('255');
      await expect(page.locator('#count-ipv6')).toHaveText('256');
      const copied = await copyShareLink(page);
      expect(decodeLink(page, copied)).toEqual(expected);
      expect(Array.isArray(decodeWire(copied).inputs[0])).toBe(item.name !== 'raw unrelated draft');
      const before = await editorSnapshot(page);
      const restored = await context.newPage();
      try {
        await restored.goto(copied);
        await expect(restored.locator('#share-status')).toHaveText('共有された内容を復元しました。');
        expect(await editorSnapshot(restored)).toEqual(before);
      } finally { await restored.close(); }
    });
  }
});

test('6000 inputs exceed the former link limit but fit and restore with compact sharing', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ready(page);
  const initial = Array.from({ length: 6000 }, (_, index) => `10.${Math.floor(index / 256)}.${index % 256}.1`);
  await page.locator('#initial-input').evaluate((element, text) => {
    (element as HTMLTextAreaElement).value = text;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, initial.join('\n'));
  await page.locator('#apply-initial').click();
  await expect(page.locator('#count-ipv4')).toHaveText('6,000');
  const link = await copyShareLink(page);
  const saved = decodeLink(page, link);
  expect(saved.request.initial).toEqual(initial);
  expect(saved.inputs.initial).toBe(initial.join('\n'));
  const oldLength = legacyHash(saved).length;
  const newLength = new URL(link).hash.length;
  expect(oldLength).toBeGreaterThan(32768);
  expect(newLength).toBeLessThanOrEqual(32768);
  console.log(`6000 input sharing comparison: former gzip ${oldLength} characters, current ${newLength} characters.`);
  const restored = await context.newPage();
  await restored.goto(link);
  await expect(restored.locator('#share-status')).toHaveText('共有された内容を復元しました。');
  await expect(restored.locator('#cidr-count')).toHaveText('6,000');
  await expect(restored.locator('#initial-input')).toHaveValue(initial.join('\n'));
  await expect(restored.locator('#cidr-list code').first()).toHaveText('10.0.0.1/32');
});

test('frozen version 2 gzip and Brotli links remain readable by the real Wasm codec', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/share-v2.json', import.meta.url), 'utf8'));
  for (const link of fixture.links) {
    await test.step(link.codec, async () => {
      await page.goto('about:blank');
      await page.goto(`/${link.hash}`);
      await expect(page.locator('#share-status')).toHaveText('共有された内容を復元しました。');
      await expect(page.locator('#cidr-list code')).toHaveText(fixture.cidrs);
      await expect(page.locator('#count-ipv4')).toHaveText('5');
      await expect(page.locator('#tab-ranges')).toHaveAttribute('aria-selected', 'true');
      const copied = await copyShareLink(page);
      expect(decodeLink(page, copied)).toEqual(fixture.state);
    });
  }
});
