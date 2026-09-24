import { expect, test, type Page } from '@playwright/test';

const preferenceKey = 'cidr.panel-preferences.v1';
const panelNames = ['operations', 'visualization', 'ranges'] as const;
type Preferences = Record<typeof panelNames[number], boolean>;

async function ready(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await expect(page.locator('#engine-status')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#result-status')).toContainText(path.startsWith('/en') ? 'Calculation complete' : '計算完了');
}

async function expectPanels(page: Page, expected: Preferences): Promise<void> {
  for (const name of panelNames) {
    await expect(page.locator(`#${name}-details`)).toHaveJSProperty('open', expected[name]);
  }
}

async function expectSavedPreferences(page: Page, expected: Preferences): Promise<void> {
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), preferenceKey)).toEqual(expected);
}

async function copyShareLink(page: Page): Promise<string> {
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.locator('#copy-share').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^https?:\/\/[^\s]+#s=2\.[gb]\.[A-Za-z0-9_-]+$/);
  return page.evaluate(() => navigator.clipboard.readText());
}

test('first visit keeps the basic workflow visible and summarizes applied operations while folded', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ready(page);
  await expectPanels(page, { operations: false, visualization: false, ranges: false });
  for (const selector of ['#initial-input', '#apply-initial', '#count-ipv4', '#count-ipv6', '#cidr-count', '#cidr-list', '#copy-cidrs', '#copy-share']) {
    await expect(page.locator(selector)).toBeVisible();
  }
  for (const selector of ['#operation-input', '#zoom-input', '#range-list']) {
    await expect(page.locator(selector)).toBeHidden();
  }
  await expect(page.locator('[role="tab"]')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/collapsed-desktop.png', fullPage: true });
  await page.locator('#initial-input').fill('192.0.2.7/30');
  await page.locator('#apply-initial').click();
  await expect(page.locator('#cidr-list code')).toHaveText(['192.0.2.4/30']);
  await page.locator('#copy-cidrs').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('192.0.2.4/30');
  await expectPanels(page, { operations: false, visualization: false, ranges: false });

  await page.locator('#load-example').click();
  await expect(page.locator('#count-ipv4')).toHaveText('5');
  await expect(page.locator('#operation-summary')).toHaveText('2件適用中');
  await expect(page.locator('#operations-details')).toHaveJSProperty('open', false);
  await page.locator('#operations-details > summary').click();
  await page.locator('#operation-input').fill('192.0.2.3');
  await page.locator('#add-operation').click();
  await expect(page.locator('#count-ipv4')).toHaveText('6');
  await page.locator('#operations-details > summary').click();
  await expect(page.locator('#operation-summary')).toHaveText('3件適用中');
  await expect(page.locator('#operation-summary')).toBeVisible();
  await page.locator('#language-en').click();
  await expect(page.locator('#operation-summary')).toHaveText('3 operations applied');
  await expect(page.locator('#operations-details')).toHaveJSProperty('open', false);
  await page.locator('#ranges-details > summary').click();
  await expect(page.locator('#visualization-details')).toHaveJSProperty('open', false);
  await page.locator('#range-list button').last().click();
  await expect(page.locator('#visualization-details')).toHaveJSProperty('open', true);
  await expect(page.locator('#range-detail')).toBeVisible();
  await expect(page.locator('#range-detail .detail-bounds dd')).toHaveText(['192.0.2.6', '192.0.2.7']);
  await expect(page.locator('#range-detail .related-cidrs code')).toHaveText(['192.0.2.6/31']);
});

test('panel preferences persist across reloads and both languages without discarding drafts', async ({ page }) => {
  await ready(page);
  const operationsSummary = page.locator('#operations-details > summary');
  await operationsSummary.focus();
  await page.keyboard.press('Enter');
  await page.locator('#ranges-details > summary').click();
  const first = { operations: true, visualization: false, ranges: true };
  await expectPanels(page, first);
  await expectSavedPreferences(page, first);
  await page.locator('#operation-input').fill('203.0.113.9');
  await page.locator('#initial-input').fill('192.0.2.0/24\nnot-applied');
  await page.locator('#language-en').click();
  await expectPanels(page, first);
  await expect(page.locator('#operation-input')).toHaveValue('203.0.113.9');
  await expect(page.locator('#initial-input')).toHaveValue('192.0.2.0/24\nnot-applied');
  await page.reload();
  await expect(page.locator('#result-status')).toContainText('Calculation complete');
  await expectPanels(page, first);

  await page.locator('#operations-details > summary').click();
  await page.locator('#visualization-details > summary').click();
  await page.locator('#ranges-details > summary').click();
  const second = { operations: false, visualization: true, ranges: false };
  await expectSavedPreferences(page, second);
  await page.locator('#language-ja').click();
  await page.reload();
  await expect(page.locator('#result-status')).toContainText('計算完了');
  await expectPanels(page, second);
  await expect(page.locator('#cidr-list')).toBeVisible();
});

test('shared links omit panel preferences and keep the recipient preferences', async ({ page, context, browser }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ready(page);
  await page.locator('#load-example').click();
  await expect(page.locator('#count-ipv4')).toHaveText('5');
  const foldedLink = await copyShareLink(page);
  for (const name of panelNames) await page.locator(`#${name}-details > summary`).click();
  const openedLink = await copyShareLink(page);
  expect(openedLink).toBe(foldedLink);

  const recipient = await browser.newContext();
  try {
    const restored = await recipient.newPage();
    await restored.goto(openedLink);
    await expect(restored.locator('#share-status')).toHaveText('共有された内容を復元しました。');
    await expect(restored.locator('#count-ipv4')).toHaveText('5');
    await expect(restored.locator('#operation-summary')).toHaveText('2件適用中');
    await expectPanels(restored, { operations: false, visualization: false, ranges: false });
    await restored.locator('#visualization-details > summary').click();
    const preference = { operations: false, visualization: true, ranges: false };
    await expectSavedPreferences(restored, preference);
    await restored.reload();
    await expect(restored.locator('#share-status')).toHaveText('共有された内容を復元しました。');
    await expectPanels(restored, preference);
    await expect(restored.locator('#cidr-list code')).toHaveText(['192.0.2.0/31', '192.0.2.2/32', '192.0.2.6/31']);
  } finally { await recipient.close(); }
});

test('real asynchronous operation and zoom errors reopen panels closed while calculating', async ({ page }) => {
  await ready(page);
  const cidrs = await page.locator('#cidr-list code').allTextContents();
  await page.locator('#operations-details > summary').click();
  await page.locator('#operation-input').fill('::ffff:192.0.2.1');
  // Close in the same event task as submission, before the real Worker reply.
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('#remove-operation')!.click();
    document.querySelector<HTMLDetailsElement>('#operations-details')!.open = false;
  });
  await expect(page.locator('#error-banner')).toContainText('operations[0].value');
  await expect(page.locator('#operations-details')).toHaveJSProperty('open', true);
  await expect(page.locator('#cidr-list code')).toHaveText(cidrs);

  await page.locator('#visualization-details > summary').click();
  await page.locator('#zoom-input').fill('fe80::1%en0');
  await page.evaluate(() => {
    document.querySelector<HTMLFormElement>('#zoom-form')!.requestSubmit();
    document.querySelector<HTMLDetailsElement>('#visualization-details')!.open = false;
  });
  await expect(page.locator('#zoom-error')).toBeVisible();
  await expect(page.locator('#zoom-error')).toContainText('unsupported_address');
  await expect(page.locator('#visualization-details')).toHaveJSProperty('open', true);
  await expect(page.locator('#cidr-list code')).toHaveText(cidrs);
});

for (const storage of ['malformed', 'unavailable'] as const) {
  test(`${storage} local storage does not prevent calculation or panel controls`, async ({ page }) => {
    await page.addInitScript(({ storage, key }) => {
      if (storage === 'malformed') localStorage.setItem(key, '{broken json');
      else Object.defineProperty(window, 'localStorage', {
        get: () => { throw new DOMException('Storage unavailable', 'SecurityError'); },
      });
    }, { storage, key: preferenceKey });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await ready(page);
    await expectPanels(page, { operations: false, visualization: false, ranges: false });
    await page.locator('#operations-details > summary').click();
    await page.locator('#operation-input').fill('203.0.113.9');
    await page.locator('#add-operation').click();
    await expect(page.locator('#operation-count')).toHaveText('1');
    await expect(page.locator('#cidr-list code')).toContainText(['203.0.113.9/32']);
    await page.locator('#operations-details > summary').click();
    await expect(page.locator('#operations-details')).toHaveJSProperty('open', false);
    expect(errors).toEqual([]);
  });
}
