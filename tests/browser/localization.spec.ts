import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sampleCidrs = ['192.0.2.0/31', '192.0.2.2/32', '192.0.2.6/31'];

async function ready(page: Page, path = '/en/'): Promise<void> {
  await page.goto(path);
  await expect(page.locator('#engine-status')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#result-status')).toContainText(path === '/' ? '計算完了' : 'Calculation complete');
}

async function apply(page: Page, input: string): Promise<void> {
  await page.locator('#initial-input').fill(input);
  await page.locator('#apply-initial').click();
  await expect(page.locator('#engine-status')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#result-status')).toContainText('Calculation complete');
}

async function openPanel(page: Page, name: 'operations' | 'visualization' | 'ranges'): Promise<void> {
  const panel = page.locator(`#${name}-details`);
  if (!await panel.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await panel.locator(':scope > summary').click();
  }
  await expect(panel).toHaveJSProperty('open', true);
}

async function expectEnglishUI(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const content = await page.evaluate(() => {
    const body = document.body.cloneNode(true) as HTMLElement;
    body.querySelector('#language-ja')?.remove();
    const attributes = Array.from(body.querySelectorAll('[aria-label], [title], [placeholder]'))
      .flatMap((element) => ['aria-label', 'title', 'placeholder'].map((name) => element.getAttribute(name) ?? ''));
    return [document.title, body.textContent ?? '', ...attributes].join('\n');
  });
  expect(content).not.toMatch(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u);
}

async function editorState(page: Page) {
  return page.evaluate(() => {
    const values = (selector: string) => Array.from(document.querySelectorAll(selector), (element) => element.textContent);
    const input = (id: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(id)!.value;
    return {
      timeOrigin: performance.timeOrigin,
      initial: input('#initial-input'),
      operation: input('#operation-input'),
      zoom: input('#zoom-input'),
      counts: values('#count-ipv4, #count-ipv6, #cidr-count, #operation-count'),
      cidrs: values('#cidr-list code'),
      ranges: values('#range-list code'),
      history: values('#operation-history code'),
      historyNumbers: values('#operation-history .history-index'),
      pagination: values('#cidr-pagination span, #range-pagination span, #history-pagination span'),
      selectedBounds: values('#range-detail .detail-bounds dd'),
      selectedCidrs: values('#range-detail .related-cidrs code'),
      axes: values('.plot-axis'),
      panels: ['operations', 'visualization', 'ranges'].map((name) => document.querySelector<HTMLDetailsElement>(`#${name}-details`)!.open),
      fit: document.querySelector('#view-fit')!.getAttribute('aria-pressed'),
      all: document.querySelector('#view-all')!.getAttribute('aria-pressed'),
      selectedMarks: Array.from(document.querySelectorAll('.range-band.selected'), (element) => element.getAttribute('data-range-index')),
    };
  });
}

test('English is available directly and after reload, with real Wasm edits and copy', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const response = await page.goto('/en');
  expect(response?.status()).toBe(200);
  expect(await response!.text()).toMatch(/<html\s+lang="en"/);
  await expect(page.locator('#result-status')).toContainText('Calculation complete');
  await expect(page.locator('h1')).toHaveText('See your address space.');
  await expect(page).toHaveTitle(/CIDR Studio/);
  await expect(page.locator('#load-example')).toHaveText('Sample');
  await expect(page.locator('#add-operation')).toContainText('Add');
  await expect(page.locator('#remove-operation')).toContainText('Remove');
  await expect(page.locator('#reset-set')).toContainText('Reset all');
  await expect(page.locator('#copy-cidrs')).toContainText('Copy');
  await expect(page.locator('#zoom-submit')).toContainText('Zoom');
  await expect(page.locator('#view-fit')).toHaveText('Fit to set');
  await expect(page.locator('.sponsor-link')).toContainText('Support on GitHub Sponsors');
  await expectEnglishUI(page);

  await page.reload();
  await expect(page.locator('#engine-status')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#result-status')).toContainText('Calculation complete');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.locator('#load-example').click();
  await expect(page.locator('#cidr-list code')).toHaveText(sampleCidrs);
  await openPanel(page, 'visualization');
  await page.locator('#plot-ipv4 .range-band').first().hover();
  await expect(page.locator('#range-detail')).toContainText('192.0.2.0/31');
  await openPanel(page, 'operations');
  await page.locator('#operation-input').fill('192.0.2.3');
  await page.locator('#add-operation').click();
  await expect(page.locator('#cidr-list code')).toHaveText(['192.0.2.0/30', '192.0.2.6/31']);
  await page.locator('#operation-input').fill('192.0.2.3');
  await page.locator('#remove-operation').click();
  await expect(page.locator('#cidr-list code')).toHaveText(sampleCidrs);
  await page.locator('#copy-cidrs').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sampleCidrs.join('\n'));
  await expect(page.locator('#copy-status')).not.toBeEmpty();
  await expectEnglishUI(page);
  await page.screenshot({ path: 'test-results/localization-en-desktop.png', fullPage: true });
  await page.locator('#reset-set').click();
  await expect(page.locator('#count-ipv4')).toHaveText('0');
  await expect(page.locator('#operation-count')).toHaveText('0');
  await expectEnglishUI(page);
});

test('offline language changes and browser history preserve drafts, edits, selection, zoom and pages', async ({ page, context }) => {
  await ready(page, '/');
  const initial = Array.from({ length: 85 }, (_, index) => `10.0.${index}.1`).join('\n');
  await page.locator('#initial-input').fill(initial);
  await page.locator('#apply-initial').click();
  await expect(page.locator('#count-ipv4')).toHaveText('85');
  await openPanel(page, 'operations');
  for (let index = 0; index < 12; index++) {
    await page.locator('#operation-input').fill(`192.0.2.${index * 2}`);
    await page.locator('#add-operation').click();
    await expect(page.locator('#operation-count')).toHaveText(String(index + 1));
  }
  await expect(page.locator('#history-pagination span')).toContainText('11–12 / 12');
  await page.locator('#cidr-pagination button').last().click();
  await expect(page.locator('#cidr-list code').first()).toHaveText('10.0.40.1/32');
  await openPanel(page, 'ranges');
  await page.locator('#range-pagination button').last().click();
  await page.locator('#range-list button').first().click();
  await page.locator('#range-detail button').first().click();
  await expect(page.locator('#plot-ipv4 .viewport-label')).toHaveText('選択した範囲');
  await page.locator('#zoom-input').fill('10.0.0.0/8');
  await page.locator('#operation-input').fill('2001:db8::7');
  await page.locator('#initial-input').fill(`${initial}\n203.0.113.7`);
  await expect(page.locator('#draft-status')).toContainText('未適用');
  const before = await editorState(page);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await context.setOffline(true);

  await page.locator('#language-en').click();
  await expect(page).toHaveURL(/\/en\/$/);
  await expect(page.locator('h1')).toHaveText('See your address space.');
  await expect(page.locator('#plot-ipv4 .viewport-label')).toHaveText('Selected range');
  await expect(page.locator('#draft-status')).not.toBeEmpty();
  await expect(page.locator('#add-operation')).toBeDisabled();
  expect(await editorState(page)).toEqual(before);
  await expectEnglishUI(page);

  await page.locator('#language-ja').click();
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.locator('#draft-status')).toContainText('未適用');
  expect(await editorState(page)).toEqual(before);
  await page.goBack();
  await expect(page).toHaveURL(/\/en\/$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await editorState(page)).toEqual(before);
  await page.goForward();
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  expect(await editorState(page)).toEqual(before);
  expect(requests).toEqual([]);
});

test('English calculation and zoom errors preserve the current set and survive a language change', async ({ page }) => {
  await ready(page);
  await apply(page, '192.0.2.7/24');
  await expect(page.locator('#cidr-list code')).toHaveText(['192.0.2.0/24']);
  await openPanel(page, 'operations');
  await page.locator('#operation-input').fill('::ffff:192.0.2.1');
  await page.locator('#remove-operation').click();
  await expect(page.locator('#error-banner')).toContainText('unsupported_address');
  await expect(page.locator('#error-banner')).toContainText('operations[0].value');
  await expect(page.locator('#count-ipv4')).toHaveText('256');
  await expect(page.locator('#operation-count')).toHaveText('0');
  await openPanel(page, 'visualization');
  await page.locator('#zoom-input').fill('fe80::1%en0');
  await page.locator('#zoom-submit').click();
  await expect(page.locator('#zoom-error')).toBeVisible();
  await expect(page.locator('#zoom-error')).toContainText('unsupported_address');
  await expectEnglishUI(page);
  await page.locator('#language-ja').click();
  await expect(page.locator('#error-banner')).toBeVisible();
  await page.locator('#language-en').click();
  await expect(page.locator('#error-banner')).toContainText('operations[0].value');
  await expect(page.locator('#zoom-error')).toBeVisible();
  await expect(page.locator('#cidr-list code')).toHaveText(['192.0.2.0/24']);
  await expectEnglishUI(page);
});

test('a nested static deployment loads real Wasm after language changes and reloads', async ({ page }) => {
  const directory = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  const requestedPaths: string[] = [];
  const contentTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.wasm': 'application/wasm',
  };
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    requestedPaths.push(pathname);
    try {
      if (!pathname.startsWith('/nested/')) {
        response.writeHead(404).end();
        return;
      }
      const path = resolve(directory, decodeURIComponent(pathname.slice('/nested/'.length)), pathname.endsWith('/') ? 'index.html' : '');
      if (!path.startsWith(`${resolve(directory)}${sep}`)) {
        response.writeHead(404).end();
        return;
      }
      const body = await readFile(path);
      response.writeHead(200, {
        'Content-Type': contentTypes[extname(path)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((onListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', onListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
  const base = `http://127.0.0.1:${address.port}/nested/`;
  try {
    await page.goto(`${base}en/index.html`);
    await expect(page.locator('#result-status')).toContainText('Calculation complete');
    await expectEnglishUI(page);
    await page.locator('#load-example').click();
    await expect(page.locator('#cidr-list code')).toHaveText(sampleCidrs);
    await page.locator('#language-ja').click();
    await expect(page).toHaveURL(base);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await expect(page.locator('#cidr-list code')).toHaveText(sampleCidrs);
    await page.reload();
    await expect(page.locator('#engine-status')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('#result-status')).toContainText('計算完了');
    await page.locator('#language-en').click();
    await expect(page).toHaveURL(`${base}en/`);
    await expectEnglishUI(page);
    await page.reload();
    await expect(page.locator('#engine-status')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('#result-status')).toContainText('Calculation complete');
    await page.locator('#load-example').click();
    await expect(page.locator('#cidr-list code')).toHaveText(sampleCidrs);
    for (const name of ['core.wasm', 'wasm_exec.js']) {
      const loads = requestedPaths.filter((path) => path.endsWith(`/${name}`));
      expect(loads.length).toBeGreaterThanOrEqual(3);
      expect(loads.every((path) => path === `/nested/wasm/${name}`)).toBe(true);
    }
    const assets = requestedPaths.filter((path) => /\.(?:js|css|wasm)$/.test(path));
    expect(assets.every((path) => path.startsWith('/nested/'))).toBe(true);
    expect(requestedPaths.some((path) => path.includes('/api/'))).toBe(false);
  } finally {
    await new Promise<void>((onClose, reject) => {
      server.close((error) => error ? reject(error) : onClose());
      server.closeAllConnections();
    });
  }
});

test('Wasm initialization failures are explained in English', async ({ page }) => {
  await page.route('**/wasm/core.wasm', (route) => route.fulfill({ status: 404, body: 'missing' }));
  await page.goto('/en/');
  await expect(page.locator('#error-banner')).toBeVisible();
  await expect(page.locator('#engine-status')).toHaveAttribute('data-state', 'failed');
  await expect(page.locator('#apply-initial')).toBeDisabled();
  await expect(page.locator('#result-status')).toContainText(/reload/i);
  await expectEnglishUI(page);
});

for (const width of [390, 320]) {
  test(`English IPv6 /0 layout fits a ${width}px mobile viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await ready(page);
    await apply(page, '::/0');
    await expect(page.locator('#count-ipv6')).toHaveAttribute('title', '340282366920938463463374607431768211456');
    expect((await page.locator('#count-ipv6').innerText()).replaceAll(',', '')).toBe('340282366920938463463374607431768211456');
    await expect(page.locator('#cidr-list code')).toHaveText(['::/0']);
    await expect(page.locator('#language-en')).toBeVisible();
    await expect(page.locator('#language-ja')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expectEnglishUI(page);
    await page.screenshot({ path: `test-results/localization-en-${width}.png`, fullPage: true });
  });
}
