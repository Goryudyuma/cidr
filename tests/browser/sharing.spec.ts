import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await expect(page.locator('#engine-status')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#result-status')).toContainText(path.startsWith('/en') ? 'Calculation complete' : '計算完了');
}

async function copyShareLink(page: Page): Promise<string> {
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.locator('#copy-share').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^https?:\/\/[^\s]+#s=1\.[A-Za-z0-9_-]+$/);
  return page.evaluate(() => navigator.clipboard.readText());
}

function validState() {
  return {
    version: 1,
    request: { initial: ['192.0.2.0/24'], operations: [] },
    inputs: { initial: '192.0.2.0/24', operation: '', zoom: '' },
    view: { mode: 'fit', viewports: {}, relatedPage: 0 },
    output: { tab: 'cidrs', cidrPage: 0, rangePage: 0, historyPage: 0 },
  };
}

async function encodeHash(page: Page, state: unknown): Promise<string> {
  return page.evaluate(async (value) => {
    const compressed = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'));
    const bytes = new Uint8Array(await new Response(compressed).arrayBuffer());
    return '#s=1.' + btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  }, state);
}

async function decodeLink(page: Page, link: string) {
  return page.evaluate(async (url) => {
    const encoded = new URL(url).hash.slice('#s=1.'.length).replaceAll('-', '+').replaceAll('_', '/');
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const decompressed = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(decompressed).text());
  }, link);
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
    expect(request.url).not.toContain(fragment.slice('#s=1.'.length));
    if (request.referer) expect(new URL(request.referer).hash).toBe('');
  }
});

test('malformed, unknown, oversized and invalid shared states fail without partial restoration', async ({ page }) => {
  await ready(page);
  const oversized = validState();
  oversized.inputs.initial = 'x'.repeat(1024 * 1024 + 1);
  const invalidRequest = validState();
  invalidRequest.request.initial.push('not-an-IP');
  const cases = [
    { name: 'malformed base64', hash: '#s=1.***' },
    { name: 'unknown envelope version', hash: '#s=99.AAAA' },
    { name: 'unknown state version', hash: await encodeHash(page, { ...validState(), version: 2 }) },
    { name: 'unknown state field', hash: await encodeHash(page, { ...validState(), unexpected: true }) },
    { name: 'unsafe page index', hash: await encodeHash(page, { ...validState(), output: { ...validState().output, cidrPage: Number.MAX_SAFE_INTEGER + 1 } }) },
    { name: 'IPv6 coordinate exceeds its address space', hash: await encodeHash(page, {
      ...validState(),
      view: { ...validState().view, viewports: { ipv6: { start: '0', end: (1n << 128n).toString(), label: { kind: 'custom', text: '::/0' } } } },
    }) },
    { name: 'oversized fragment', hash: '#s=1.' + 'A'.repeat(32768) },
    { name: 'gzip expands beyond 1 MiB', hash: await encodeHash(page, oversized) },
    { name: 'valid prefix followed by an invalid IP', hash: await encodeHash(page, invalidRequest) },
  ];
  for (const item of cases) {
    await test.step(item.name, async () => {
      await page.goto('about:blank');
      await page.goto(`/${item.hash}`);
      await expect(page.locator('#share-status')).toContainText(/共有リンクが正しく|未対応の共有リンク|サイズ上限/);
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

test('a draft larger than the sharing limit leaves the applied set usable', async ({ page }) => {
  await ready(page);
  await page.locator('#load-example').click();
  await expect(page.locator('#count-ipv4')).toHaveText('5');
  const applied = await page.locator('#initial-input').inputValue();
  await page.locator('#initial-input').evaluate((element, value) => {
    (element as HTMLTextAreaElement).value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, 'x'.repeat(1024 * 1024 + 1));
  await page.locator('#copy-share').click();
  await expect(page.locator('#share-status')).toContainText('サイズ上限');
  await expect(page.locator('#share-fallback')).toBeHidden();
  await expect(page.locator('#count-ipv4')).toHaveText('5');
  await expect(page.locator('#operation-count')).toHaveText('2');
  await expect(page.locator('#copy-cidrs')).toBeEnabled();
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
  expect(new URL(link).hash).toMatch(/^#s=1\.[A-Za-z0-9_-]+$/);
  const restored = await context.newPage();
  await restored.goto(link);
  await expect(restored.locator('#engine-status')).toHaveAttribute('data-state', 'ready');
  await expect(restored.locator('#cidr-list code')).toHaveText(['192.0.2.0/31', '192.0.2.2/32', '192.0.2.6/31']);
});
