import { test, expect, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#engine-status')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#result-status')).toContainText('計算完了');
}

async function apply(page: Page, input: string): Promise<void> {
  await page.locator('#initial-input').fill(input);
  await page.locator('#apply-initial').click();
  await expect(page.locator('#result-status')).toContainText('計算完了');
}

test('example, ordered edits, copy, details, and reset work without a network', async ({ page, context }) => {
  const network: string[] = [];
  page.on('request', (request) => network.push(request.url()));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ready(page);
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  network.length = 0;
  await context.setOffline(true);
  await page.locator('#load-example').click();
  await expect(page.locator('#cidr-list code')).toHaveText(['192.0.2.0/31', '192.0.2.2/32', '192.0.2.6/31']);
  await expect(page.locator('#count-ipv4')).toHaveText('5');
  await page.locator('#copy-cidrs').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('192.0.2.0/31\n192.0.2.2/32\n192.0.2.6/31');
  await page.locator('#plot-ipv4 .range-band').first().hover();
  await expect(page.locator('#range-detail')).toContainText('192.0.2.0');
  await expect(page.locator('#range-detail')).toContainText('192.0.2.2');
  await expect(page.locator('#range-detail')).toContainText('192.0.2.0/31');
  await page.locator('#operation-input').fill('192.0.2.3');
  await page.locator('#add-operation').click();
  await expect(page.locator('#cidr-list code')).toHaveText(['192.0.2.0/30', '192.0.2.6/31']);
  await page.locator('#operation-input').fill('192.0.2.3');
  await page.locator('#remove-operation').click();
  await expect(page.locator('#count-ipv4')).toHaveText('5');
  await page.locator('#tab-ranges').click();
  await expect(page.locator('#range-list code')).toHaveText(['192.0.2.0 → 192.0.2.2', '192.0.2.6 → 192.0.2.7']);
  await page.locator('#range-list button').last().click();
  await expect(page.locator('#range-detail')).toContainText('192.0.2.6/31');
  await page.locator('#reset-set').click();
  await expect(page.locator('#count-ipv4')).toHaveText('0');
  await expect(page.locator('#count-ipv6')).toHaveText('0');
  await expect(page.locator('#operation-count')).toHaveText('0');
  await expect(page.locator('#initial-input')).toHaveValue('');
  expect(network).toEqual([]);
});

test('invalid edits and zoom display structured errors and preserve the set', async ({ page }) => {
  await ready(page);
  await apply(page, '192.0.2.7/24');
  await expect(page.locator('#cidr-list code')).toHaveText(['192.0.2.0/24']);
  await page.locator('#operation-input').fill('::ffff:192.0.2.1');
  await page.locator('#remove-operation').click();
  await expect(page.locator('#error-banner')).toContainText('operations[0].value');
  await expect(page.locator('#error-banner')).toContainText('unsupported_address');
  await expect(page.locator('#count-ipv4')).toHaveText('256');
  await expect(page.locator('#operation-count')).toHaveText('0');
  await page.locator('#zoom-input').fill('fe80::1%en0');
  await page.locator('#zoom-submit').click();
  await expect(page.locator('#zoom-error')).toBeVisible();
  await expect(page.locator('#cidr-list code')).toHaveText(['192.0.2.0/24']);
  await apply(page, '');
  await expect(page.locator('#cidr-count')).toHaveText('0');
});

test('IPv6 /0 counts exactly and zoom retains low address bits and tiny markers', async ({ page }) => {
  await ready(page);
  await apply(page, '0.0.0.0/0\n::/0');
  expect((await page.locator('#count-ipv6').innerText()).replaceAll(',', '')).toBe('340282366920938463463374607431768211456');
  await expect(page.locator('#count-ipv4')).toHaveText('4,294,967,296');
  await apply(page, 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:fff1\nffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe');
  await page.locator('#view-all').click();
  await expect(page.locator('#plot-ipv6 .range-marker')).toHaveCount(1);
  await page.locator('#plot-ipv6 .range-marker').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#range-detail')).toContainText('ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe');
  await page.locator('#zoom-input').fill('ffff:ffff:ffff:ffff:ffff:ffff:ffff:fff0/124');
  await page.locator('#zoom-submit').click();
  await expect(page.locator('#plot-ipv6 .range-band')).toHaveCount(2);
  const coords = await page.locator('#plot-ipv6 .range-band').evaluateAll((bands) => bands.map((band) => Number(band.getAttribute('x'))));
  expect(coords[1] - coords[0]).toBeGreaterThan(700);
  await expect(page.locator('#plot-ipv6 .plot-axis')).toContainText('ffff:ffff:ffff:ffff:ffff:ffff:ffff:fff0');
});

test('real Worker replies cannot replace a newer reset or edited draft', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>('#initial-input')!;
    input.value = '::/0';
    input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('#apply-initial')!.click();
    document.querySelector<HTMLButtonElement>('#reset-set')!.click();
  });
  await expect(page.locator('#result-status')).toContainText('計算完了');
  await expect(page.locator('#cidr-count')).toHaveText('0');
  await expect(page.locator('#count-ipv6')).toHaveText('0');
  await page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>('#initial-input')!;
    input.value = '0.0.0.0/0';
    input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('#apply-initial')!.click();
    input.value = '192.0.2.1';
    input.dispatchEvent(new Event('input'));
  });
  await expect(page.locator('#draft-status')).toContainText('未適用');
  // A subsequent real zoom response is a barrier after all earlier Worker calculations.
  await page.locator('#zoom-input').fill('192.0.2.0/24');
  await page.locator('#zoom-submit').click();
  await expect(page.locator('#plot-ipv4 .viewport-label')).toHaveText('192.0.2.0/24');
  await expect(page.locator('#cidr-count')).toHaveText('0');
});

test('a pending typed zoom cannot replace a newer selected-range zoom', async ({ page }) => {
  await ready(page);
  await page.locator('#plot-ipv4 .range-band').click();
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#zoom-input')!;
    input.value = '0.0.0.0/0';
    input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLFormElement>('#zoom-form')!.requestSubmit();
    document.querySelector<HTMLButtonElement>('#range-detail button')!.click();
  });
  // Another real Worker request provides a completion barrier without mocking replies.
  await page.locator('#operation-input').fill('192.0.2.0');
  await page.locator('#add-operation').click();
  await expect(page.locator('#operation-count')).toHaveText('1');
  await expect(page.locator('#plot-ipv4 .viewport-label')).toHaveText('選択した範囲');
  await expect(page.locator('#plot-ipv4 .plot-axis')).toHaveText('192.0.2.0192.0.2.255');
});

test('Wasm accepts more than 4096 inputs and result lists stay paginated', async ({ page }) => {
  await ready(page);
  const input = Array.from({ length: 5000 }, (_, i) => `10.${Math.floor(i / 256)}.${i % 256}.1`).join('\n');
  // A programmatic paste avoids OS text-insertion cost for thousands of lines.
  await page.locator('#initial-input').evaluate((element, text) => {
    (element as HTMLTextAreaElement).value = text;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, input);
  await page.locator('#apply-initial').click();
  await expect(page.locator('#result-status')).toContainText('計算完了');
  await expect(page.locator('#count-ipv4')).toHaveText('5,000');
  await expect(page.locator('#cidr-count')).toHaveText('5,000');
  await expect(page.locator('#cidr-list li')).toHaveCount(40);
  await expect(page.locator('#cidr-pagination')).toBeVisible();
  await page.locator('#cidr-pagination button').last().click();
  await expect(page.locator('#cidr-list code').first()).toHaveText('10.0.40.1/32');
  await expect(page.locator('#plot-ipv4 .range-band')).not.toHaveCount(0);
});

test('Wasm initialization failure is visible', async ({ page }) => {
  await page.route('**/wasm/core.wasm', (route) => route.fulfill({ status: 404, body: 'missing' }));
  await page.goto('/');
  await expect(page.locator('#error-banner')).toBeVisible();
  await expect(page.locator('#engine-status')).toHaveAttribute('data-state', 'failed');
  await expect(page.locator('#apply-initial')).toBeDisabled();
});

test('synchronous Worker construction failure is visible', async ({ page }) => {
  await page.addInitScript(() => {
    window.Worker = class {
      constructor() { throw new DOMException('Worker blocked by policy', 'SecurityError'); }
    } as unknown as typeof Worker;
  });
  await page.goto('/');
  await expect(page.locator('#error-banner')).toContainText('Worker blocked by policy');
  await expect(page.locator('#engine-status')).toHaveAttribute('data-state', 'failed');
});

test('mobile layout fits the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await apply(page, '::/0');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
});
