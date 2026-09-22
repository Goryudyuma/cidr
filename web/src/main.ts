import './style.css';
import { Engine, formatEngineError } from './engine';
import { getLocale, setLocale, localeURL, localeFromURL, type Locale } from './i18n';
import { text, type MessageKey } from './messages';
import type { Operation, Request, Result } from './types';
import { Visualization } from './visualization';
import { decodeShare, encodeShare, ShareError, type SharedState } from './share';

const label = (key: MessageKey): string => `<span data-i18n="${key}">${text(key)}</span>`;

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="app-shell">
    <header class="site-header">
      <a class="brand" href="${localeURL(getLocale()).pathname}" data-i18n-aria="home" aria-label="${text('home')}"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><span>CIDR<span class="brand-light"> Studio</span></span></a>
      <nav class="language-switch" data-i18n-aria="language" aria-label="${text('language')}">
        <a id="language-ja" href="${localeURL('ja').pathname}" lang="ja" hreflang="ja">日本語</a>
        <a id="language-en" href="${localeURL('en').pathname}" lang="en" hreflang="en">English</a>
      </nav>
      <div id="engine-status" class="engine-status" role="status" data-state="loading"><span class="status-dot"></span><span id="engine-status-text">${text('engineLoading')}</span></div>
    </header>

    <main>
      <div class="page-heading">
        <div><p class="eyebrow">IP ADDRESS WORKSPACE</p><h1>${label('heading')}</h1><p class="page-description">${label('introduction')}</p></div>
        <div class="heading-actions"><button id="copy-share" class="button button-quiet" type="button" aria-describedby="share-help" disabled><span aria-hidden="true">⧉</span> ${label('share')}</button><button id="reset-set" class="button button-quiet" type="button" disabled><span aria-hidden="true">↺</span> ${label('reset')}</button></div>
      </div>
      <div class="share-feedback"><p id="share-help" data-i18n="shareHelp">${text('shareHelp')}</p><p id="share-status" role="status"></p><div id="share-fallback" hidden><label for="share-link" data-i18n="shareLink">${text('shareLink')}</label><input id="share-link" class="mono-input" readonly spellcheck="false" /></div></div>
      <div id="error-banner" class="error-banner" role="alert" hidden></div>

      <div class="workspace">
        <aside class="editor-column" data-i18n-aria="editor" aria-label="${text('editor')}">
          <section class="panel input-panel">
            <div class="section-heading"><div><span class="step-number">01</span><h2>${label('initial')}</h2></div><button id="load-example" class="text-button" type="button" disabled>${label('sample')}</button></div>
            <label for="initial-input" class="field-label">IP / CIDR ${label('onePerLine')}</label>
            <textarea id="initial-input" spellcheck="false" autocomplete="off" rows="7" aria-describedby="initial-help" placeholder="192.0.2.0/24&#10;2001:db8::/120">192.0.2.0/24
2001:db8::/120</textarea>
            <p id="initial-help" class="field-help">${label('initialHelp')}</p>
            <button id="apply-initial" class="button button-primary full-width" type="button" disabled>${label('apply')} <span aria-hidden="true">→</span></button>
            <p id="draft-status" class="draft-status" aria-live="polite"></p>
          </section>

          <section class="panel operation-panel">
            <div class="section-heading"><div><span class="step-number">02</span><h2>${label('edit')}</h2></div></div>
            <label for="operation-input" class="field-label" data-i18n="operationInput">${text('operationInput')}</label>
            <input id="operation-input" class="mono-input" spellcheck="false" autocomplete="off" placeholder="192.0.2.64/26" aria-describedby="operation-help" />
            <div class="operation-buttons"><button id="add-operation" class="button button-add" type="button" disabled><span aria-hidden="true">＋</span> ${label('add')}</button><button id="remove-operation" class="button button-remove" type="button" disabled><span aria-hidden="true">−</span> ${label('remove')}</button></div>
            <p id="operation-help" class="field-help">${label('operationHelp')}</p>
            <div class="history-heading"><h3>${label('history')}</h3><span id="operation-count" class="count-badge">0</span></div>
            <ol id="operation-history" class="operation-history"></ol>
            <div id="history-pagination" class="pagination" hidden></div>
          </section>
          <p class="local-note"><span class="local-icon" aria-hidden="true">◈</span><span>${label('localCalculation')}<br> ${label('privateInput')}</span></p>
        </aside>

        <div class="result-column">
          <section class="stats" data-i18n-aria="totals" aria-label="${text('totals')}">
            <div class="stat"><span class="stat-label"><span class="family-dot ipv4"></span>${label('ipv4Count')}</span><strong id="count-ipv4" class="stat-value">0</strong><span class="stat-unit">addresses</span></div>
            <div class="stat"><span class="stat-label"><span class="family-dot ipv6"></span>${label('ipv6Count')}</span><strong id="count-ipv6" class="stat-value">0</strong><span class="stat-unit">addresses</span></div>
            <div class="stat stat-compact"><span class="stat-label">${label('cidrs')}</span><strong id="cidr-count" class="stat-value">0</strong><span class="stat-unit">prefixes</span></div>
          </section>

          <section class="panel visualization-panel" aria-labelledby="visualization-heading">
            <div class="visualization-heading"><div><span class="eyebrow">ADDRESS SPACE</span><h2 id="visualization-heading">${label('overview')}</h2></div><div class="segmented-control" data-i18n-aria="viewport" aria-label="${text('viewport')}"><button id="view-fit" type="button" class="active" aria-pressed="true">${label('fit')}</button><button id="view-all" type="button" aria-pressed="false">${label('all')}</button></div></div>
            <form id="zoom-form" class="zoom-form"><label for="zoom-input">${label('viewport')}</label><input id="zoom-input" class="mono-input" data-i18n-placeholder="zoomPlaceholder" placeholder="${text('zoomPlaceholder')}" spellcheck="false" autocomplete="off" /><button id="zoom-submit" class="button button-quiet" type="submit" disabled>${label('zoom')} <span aria-hidden="true">↗</span></button></form>
            <p id="zoom-error" class="inline-error" role="alert" hidden></p>
            <div id="visualization"></div>
            <div class="plot-legend"><span><i class="legend-band"></i>${label('legendBand')}</span><span><i class="legend-marker"></i>${label('legendMarker')}</span><span>${label('inclusive')}</span></div>
          </section>

          <section class="panel output-panel" data-i18n-aria="results" aria-label="${text('results')}">
            <div class="output-heading"><div class="output-tabs" role="tablist" data-i18n-aria="resultFormat" aria-label="${text('resultFormat')}"><button id="tab-cidrs" class="active" type="button" role="tab" aria-selected="true" aria-controls="cidrs-panel">${label('cidrs')} <span id="cidr-tab-count" class="count-badge">0</span></button><button id="tab-ranges" type="button" role="tab" aria-selected="false" aria-controls="ranges-panel" tabindex="-1">${label('ranges')} <span id="range-tab-count" class="count-badge">0</span></button></div><button id="copy-cidrs" class="text-button" type="button" disabled>${label('copy')} <span aria-hidden="true">⧉</span></button></div>
            <div id="cidrs-panel" role="tabpanel" aria-labelledby="tab-cidrs"><div class="output-table-heading"><span>NETWORK / PREFIX</span><span>FAMILY</span></div><ol id="cidr-list" class="cidr-list"></ol><div id="cidr-pagination" class="pagination" hidden></div></div>
            <div id="ranges-panel" role="tabpanel" aria-labelledby="tab-ranges" hidden><div class="output-table-heading"><span>${label('rangeHeading')}</span><span>FAMILY</span></div><ol id="range-list" class="range-list"></ol><div id="range-pagination" class="pagination" hidden></div></div>
            <div class="output-footer"><span id="result-status" role="status">${text('waiting')}</span><span id="copy-status" role="status"></span></div>
          </section>
        </div>
      </div>
    </main>
    <footer class="site-footer">
      <div class="footer-info"><span class="footer-brand">CIDR Studio</span><span>${label('footer')}</span></div>
      <a class="sponsor-link" href="https://github.com/sponsors/Goryudyuma" target="_blank" rel="noopener noreferrer" data-i18n-aria="sponsorLabel" aria-label="${text('sponsorLabel')}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" /></svg>
        ${label('sponsor')} <span aria-hidden="true">↗</span>
      </a>
    </footer>
  </div>`;

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const initialInput = $<HTMLTextAreaElement>('#initial-input');
const operationInput = $<HTMLInputElement>('#operation-input');
const zoomInput = $<HTMLInputElement>('#zoom-input');
const errorBanner = $('#error-banner');
const resultStatus = $('#result-status');
const engine = new Engine();
const visualization = new Visualization($('#visualization'), () => { zoomGeneration++; setViewButton('custom'); });
let initial: string[] = [];
let operations: Operation[] = [];
let result: Result = { cidrs: [], ranges: [], addressCount: { ipv4: '0', ipv6: '0' } };
let ready = false;
let failed = false;
let busy = false;
let generation = 0;
let zoomGeneration = 0;
let cidrPage = 0;
let rangePage = 0;
let historyPage = 0;
const pageSize = 40;
const historyPageSize = 10;
let resultState: MessageKey = 'waiting';
let elapsedMS = 0;
let copyState: 'copied' | 'copyFailed' | undefined;
let visibleError: unknown;
let zoomFailure: unknown;
let shareState: MessageKey | undefined;
let shareBusy = false;
let shareGeneration = 0;
let restoring = false;
let observedHash = window.location.hash;

function setShareStatus(state?: MessageKey): void {
  shareState = state;
  $('#share-status').textContent = state ? text(state) : '';
}

function clearShareFeedback(): void {
  shareGeneration++;
  shareBusy = false;
  setShareStatus();
  $('#share-fallback').hidden = true;
  $<HTMLInputElement>('#share-link').value = '';
}

function shareError(error: unknown): void {
  setShareStatus(error instanceof ShareError
    ? error.code === 'tooLarge' ? 'shareTooLarge' : error.code === 'unsupported' ? 'shareUnsupported' : 'shareInvalid'
    : 'shareInvalid');
}

function updateLanguageLinks(): void {
  for (const locale of ['ja', 'en'] as const) {
    const url = localeURL(locale); url.hash = window.location.hash;
    $<HTMLAnchorElement>(`#language-${locale}`).href = url.href;
  }
}

function setResultStatus(state: MessageKey): void {
  resultState = state;
  resultStatus.textContent = text(state) + (state === 'complete' ? ` · ${elapsedMS.toLocaleString(getLocale())} ms` : '');
}

function setCopyStatus(state: 'copied' | 'copyFailed'): void {
  copyState = state;
  $('#copy-status').textContent = text(state);
}

function refreshLocale(): void {
  document.documentElement.lang = getLocale();
  document.title = text('title');
  document.querySelector<HTMLMetaElement>('meta[name="description"]')!.content = text('description');
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    element.textContent = text(element.dataset.i18n as MessageKey);
  }
  for (const [data, attribute] of [['data-i18n-aria', 'aria-label'], ['data-i18n-placeholder', 'placeholder']]) {
    for (const element of document.querySelectorAll(`[${data}]`)) {
      element.setAttribute(attribute, text(element.getAttribute(data) as MessageKey));
    }
  }
  $<HTMLAnchorElement>('.brand').href = localeURL(getLocale()).pathname;
  updateLanguageLinks();
  for (const locale of ['ja', 'en'] as const) {
    document.querySelector<HTMLLinkElement>(`link[rel="alternate"][hreflang="${locale}"]`)!.href = localeURL(locale).pathname;
    const link = $<HTMLAnchorElement>(`#language-${locale}`);
    if (getLocale() === locale) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  // Refresh labels without recalculating, replacing input nodes or resetting views.
  renderHistory(); renderCidrs(); renderRanges();
  visualization.refreshLocale();
  updateControls();
  setResultStatus(resultState);
  if (copyState) setCopyStatus(copyState);
  setShareStatus(shareState);
  if (!errorBanner.hidden) errorBanner.textContent = formatEngineError(visibleError);
  if (!$('#zoom-error').hidden) $('#zoom-error').textContent = formatEngineError(zoomFailure);
}

function changeLocale(locale: Locale): void {
  if (getLocale() === locale) return;
  setLocale(locale);
  refreshLocale();
}

for (const locale of ['ja', 'en'] as const) {
  $(`#language-${locale}`).addEventListener('click', (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    if (getLocale() === locale) return;
    const url = new URL(window.location.href);
    url.pathname = localeURL(locale).pathname;
    history.pushState(null, '', url);
    changeLocale(locale);
  });
}
function followLocation(): void {
  changeLocale(localeFromURL());
  const hash = window.location.hash;
  if (hash === observedHash) return;
  const wasShared = observedHash.startsWith('#s=');
  observedHash = hash;
  updateLanguageLinks();
  if (hash.startsWith('#s=') || wasShared) void restoreShare(hash);
}
window.addEventListener('popstate', followLocation);
window.addEventListener('hashchange', followLocation);

function inputLines(): string[] { return initialInput.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); }
function isDraft(): boolean { return JSON.stringify(inputLines()) !== JSON.stringify(initial); }
function groupedInteger(value: string): string { return value.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

function updateControls(): void {
  for (const id of ['#apply-initial', '#load-example']) $<HTMLButtonElement>(id).disabled = !ready || busy;
  for (const id of ['#add-operation', '#remove-operation']) $<HTMLButtonElement>(id).disabled = !ready || busy || isDraft() || !operationInput.value.trim();
  $<HTMLButtonElement>('#reset-set').disabled = !ready;
  $<HTMLButtonElement>('#zoom-submit').disabled = !ready || !zoomInput.value.trim();
  $<HTMLButtonElement>('#copy-cidrs').disabled = !ready || result.cidrs.length === 0;
  $<HTMLButtonElement>('#copy-share').disabled = !ready || busy || shareBusy;
  $('#draft-status').textContent = ready && isDraft() ? text('draft') : '';
  const status = $('#engine-status');
  status.dataset.state = failed ? 'failed' : busy || !ready ? 'loading' : 'ready';
  $('#engine-status-text').textContent = failed ? text('engineFailed') : !ready ? text('engineLoading') : busy ? text('engineBusy') : text('engineReady');
}

function showError(error: unknown): void {
  visibleError = error;
  errorBanner.textContent = formatEngineError(error);
  errorBanner.hidden = false;
}

function clearError(): void { errorBanner.hidden = true; errorBanner.textContent = ''; }

function invalidatePending(): void {
  generation++;
  zoomGeneration++;
  restoring = false;
  clearShareFeedback();
  if (busy) setResultStatus('canceled');
  busy = false;
  updateControls();
}

async function evaluate(request: Request, afterCommit?: () => void): Promise<void> {
  const current = ++generation;
  restoring = false;
  clearShareFeedback();
  zoomGeneration++;
  busy = true;
  clearError();
  setResultStatus('calculating');
  updateControls();
  const started = performance.now();
  try {
    const evaluated = await engine.evaluate(request);
    if (current !== generation) return;
    initial = [...(request.initial ?? [])];
    operations = [...(request.operations ?? [])];
    result = evaluated;
    cidrPage = 0;
    rangePage = 0;
    historyPage = Math.max(0, Math.ceil(operations.length / historyPageSize) - 1);
    afterCommit?.();
    renderResult();
    elapsedMS = Math.max(1, Math.round(performance.now() - started));
    setResultStatus('complete');
  } catch (error) {
    if (current !== generation) return;
    showError(error);
    setResultStatus('invalid');
  } finally {
    if (current === generation) { busy = false; updateControls(); }
  }
}

function clearWorkspace(): void {
  initial = []; operations = [];
  result = { cidrs: [], ranges: [], addressCount: { ipv4: '0', ipv6: '0' } };
  initialInput.value = ''; operationInput.value = ''; zoomInput.value = '';
  cidrPage = rangePage = historyPage = 0;
  $('#zoom-error').hidden = true;
  copyState = undefined; $('#copy-status').textContent = '';
  visualization.setMode('fit'); setViewButton('fit'); switchTab('cidrs');
  clearError(); renderResult();
}

async function restoreShare(hash: string): Promise<void> {
  const current = ++generation;
  zoomGeneration++;
  clearShareFeedback(); clearWorkspace();
  restoring = true; busy = true;
  setShareStatus('shareRestoring'); updateControls();
  const started = performance.now();
  try {
    const shared = await decodeShare(hash);
    if (current !== generation) return;
    await engine.ready;
    if (current !== generation) return;
    if (!shared) { setShareStatus(); setResultStatus('complete'); return; }
    // Validate and recalculate with the same Go core as every other edit.
    const evaluated = await engine.evaluate(shared.request);
    if (current !== generation) return;
    initial = [...shared.request.initial]; operations = shared.request.operations.map((op) => ({ ...op }));
    result = evaluated;
    initialInput.value = shared.inputs.initial;
    operationInput.value = shared.inputs.operation;
    zoomInput.value = shared.inputs.zoom;
    const clampPage = (page: number, count: number, size: number): number => Math.min(page, Math.max(0, Math.ceil(count / size) - 1));
    cidrPage = clampPage(shared.output.cidrPage, result.cidrs.length, pageSize);
    rangePage = clampPage(shared.output.rangePage, result.ranges.length, pageSize);
    historyPage = clampPage(shared.output.historyPage, operations.length, historyPageSize);
    renderResult();
    visualization.restoreView(shared.view);
    setViewButton(Object.keys(shared.view.viewports).length ? 'custom' : shared.view.mode);
    switchTab(shared.output.tab);
    elapsedMS = Math.max(1, Math.round(performance.now() - started));
    setResultStatus('complete'); setShareStatus('shareRestored');
  } catch (error) {
    if (current !== generation) return;
    shareError(error);
    if (!(error instanceof ShareError)) showError(error);
    setResultStatus('invalid');
  } finally {
    if (current === generation) { restoring = false; busy = false; updateControls(); }
  }
}

function renderPagination(container: HTMLElement, count: number, page: number, size: number, onChange: (page: number) => void): void {
  container.replaceChildren();
  container.hidden = count <= size;
  if (container.hidden) return;
  const previous = document.createElement('button'); previous.type = 'button'; previous.textContent = `← ${text('previous')}`; previous.disabled = page === 0;
  previous.addEventListener('click', () => onChange(page - 1));
  const label = document.createElement('span'); label.textContent = `${page * size + 1}–${Math.min((page + 1) * size, count)} / ${count.toLocaleString(getLocale())}`;
  const next = document.createElement('button'); next.type = 'button'; next.textContent = `${text('next')} →`; next.disabled = (page + 1) * size >= count;
  next.addEventListener('click', () => onChange(page + 1));
  container.append(previous, label, next);
}

function emptyRow(text: string): HTMLLIElement {
  const row = document.createElement('li'); row.className = 'empty-row'; row.textContent = text; return row;
}

function renderHistory(): void {
  $('#operation-count').textContent = operations.length.toLocaleString(getLocale());
  const list = $('#operation-history'); list.replaceChildren();
  if (operations.length === 0) list.append(emptyRow(text('noOperations')));
  for (const [index, operation] of operations.slice(historyPage * historyPageSize, (historyPage + 1) * historyPageSize).entries()) {
    const row = document.createElement('li');
    const number = document.createElement('span'); number.className = 'history-index'; number.textContent = String(historyPage * historyPageSize + index + 1).padStart(2, '0');
    const action = document.createElement('span'); action.className = `operation-badge ${operation.op}`; action.textContent = text(operation.op);
    const value = document.createElement('code'); value.textContent = operation.value;
    row.append(number, action, value); list.append(row);
  }
  renderPagination($('#history-pagination'), operations.length, historyPage, historyPageSize, (page) => { historyPage = page; renderHistory(); });
}

function familyLabel(ip: string): HTMLSpanElement {
  const label = document.createElement('span'); label.className = `family-tag ${ip.includes(':') ? 'ipv6' : 'ipv4'}`; label.textContent = ip.includes(':') ? 'IPv6' : 'IPv4'; return label;
}

function renderCidrs(): void {
  const list = $('#cidr-list'); list.replaceChildren();
  if (result.cidrs.length === 0) list.append(emptyRow(text('emptyCidrs')));
  for (const cidr of result.cidrs.slice(cidrPage * pageSize, (cidrPage + 1) * pageSize)) {
    const row = document.createElement('li'); const value = document.createElement('code'); value.textContent = cidr;
    row.append(value, familyLabel(cidr)); list.append(row);
  }
  renderPagination($('#cidr-pagination'), result.cidrs.length, cidrPage, pageSize, (page) => { cidrPage = page; renderCidrs(); });
}

function renderRanges(): void {
  const list = $('#range-list'); list.replaceChildren();
  if (result.ranges.length === 0) list.append(emptyRow(text('emptyRanges')));
  for (const [index, range] of result.ranges.slice(rangePage * pageSize, (rangePage + 1) * pageSize).entries()) {
    const row = document.createElement('li');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'range-row-button';
    const value = document.createElement('code'); value.textContent = `${range.start} → ${range.end}`;
    button.append(value, familyLabel(range.start));
    button.addEventListener('click', () => { visualization.select(rangePage * pageSize + index); $('#range-detail').scrollIntoView({ block: 'nearest' }); });
    row.append(button); list.append(row);
  }
  renderPagination($('#range-pagination'), result.ranges.length, rangePage, pageSize, (page) => { rangePage = page; renderRanges(); });
}

function renderResult(): void {
  for (const family of ['ipv4', 'ipv6'] as const) {
    const counter = $(`#count-${family}`);
    counter.textContent = groupedInteger(result.addressCount[family]);
    counter.title = result.addressCount[family];
    counter.classList.toggle('long-number', result.addressCount[family].length > 15);
  }
  $('#cidr-count').textContent = result.cidrs.length.toLocaleString(getLocale());
  $('#cidr-tab-count').textContent = result.cidrs.length.toLocaleString(getLocale());
  $('#range-tab-count').textContent = result.ranges.length.toLocaleString(getLocale());
  renderHistory(); renderCidrs(); renderRanges(); visualization.setResult(result);
}

initialInput.addEventListener('input', invalidatePending);
operationInput.addEventListener('input', invalidatePending);
zoomInput.addEventListener('input', () => { if (restoring) invalidatePending(); zoomGeneration++; $('#zoom-error').hidden = true; updateControls(); });
$('#apply-initial').addEventListener('click', () => { void evaluate({ initial: inputLines(), operations: [] }); });

for (const op of ['add', 'remove'] as const) {
  $(`#${op}-operation`).addEventListener('click', () => {
    const value = operationInput.value.trim();
    if (!value || !ready || busy || isDraft()) return;
    void evaluate({ initial, operations: [...operations, { op, value }] }, () => { operationInput.value = ''; });
  });
}

$('#reset-set').addEventListener('click', () => {
  if (window.location.hash.startsWith('#s=')) {
    const url = new URL(window.location.href); url.hash = '';
    history.replaceState(null, '', url); observedHash = ''; updateLanguageLinks();
  }
  clearWorkspace();
  void evaluate({ initial: [], operations: [] });
});

$('#load-example').addEventListener('click', () => {
  const sample = ['192.0.2.0/30', '192.0.2.4/30'];
  initialInput.value = sample.join('\n'); operationInput.value = '';
  visualization.setMode('fit'); setViewButton('fit');
  void evaluate({ initial: sample, operations: [{ op: 'remove', value: '192.0.2.3' }, { op: 'remove', value: '192.0.2.4/31' }] });
});

function setViewButton(mode: 'fit' | 'all' | 'custom'): void {
  for (const value of ['fit', 'all'] as const) {
    const button = $(`#view-${value}`); button.classList.toggle('active', mode === value); button.setAttribute('aria-pressed', String(mode === value));
  }
}

for (const mode of ['fit', 'all'] as const) {
  $(`#view-${mode}`).addEventListener('click', () => { if (restoring) invalidatePending(); zoomGeneration++; visualization.setMode(mode); setViewButton(mode); $('#zoom-error').hidden = true; });
}

$('#zoom-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!ready || !zoomInput.value.trim()) return;
  const current = ++zoomGeneration;
  const value = zoomInput.value.trim();
  const zoomError = $('#zoom-error'); zoomError.hidden = true;
  try {
    const validated = await engine.evaluate({ initial: [value] });
    if (current !== zoomGeneration) return;
    if (validated.ranges.length === 1) { visualization.zoom(validated.ranges[0], validated.cidrs[0]); setViewButton('custom'); }
  } catch (error) {
    if (current !== zoomGeneration) return;
    zoomFailure = error; zoomError.textContent = formatEngineError(error); zoomError.hidden = false;
  }
});

function switchTab(tab: 'cidrs' | 'ranges'): void {
  for (const name of ['cidrs', 'ranges'] as const) {
    const selected = tab === name;
    $(`#${name}-panel`).hidden = !selected;
    const button = $<HTMLButtonElement>(`#tab-${name}`); button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; button.classList.toggle('active', selected);
  }
}

for (const name of ['cidrs', 'ranges'] as const) {
  $(`#tab-${name}`).addEventListener('click', () => switchTab(name));
  $(`#tab-${name}`).addEventListener('keydown', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 'cidrs' : event.key === 'End' ? 'ranges' : name === 'cidrs' ? 'ranges' : 'cidrs';
      switchTab(next); $(`#tab-${next}`).focus();
    }
  });
}

$('#copy-cidrs').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(result.cidrs.join('\n')); setCopyStatus('copied'); }
  catch { setCopyStatus('copyFailed'); }
});

$('#copy-share').addEventListener('click', async () => {
  if (!ready || busy || shareBusy) return;
  clearShareFeedback();
  const current = shareGeneration;
  const snapshot: SharedState = {
    version: 1,
    request: { initial: [...initial], operations: operations.map((op) => ({ ...op })) },
    inputs: { initial: initialInput.value, operation: operationInput.value, zoom: zoomInput.value },
    view: visualization.exportView(),
    output: { tab: $('#ranges-panel').hidden ? 'cidrs' : 'ranges', cidrPage, rangePage, historyPage },
  };
  // Capture the locale at click time, just like the rest of the snapshot.
  const url = localeURL(getLocale());
  shareBusy = true; setShareStatus('shareCreating'); updateControls();
  try {
    url.hash = await encodeShare(snapshot);
    if (current !== shareGeneration) return;
    try {
      await navigator.clipboard.writeText(url.href);
      if (current === shareGeneration) setShareStatus('shareCopied');
    } catch {
      if (current !== shareGeneration) return;
      const input = $<HTMLInputElement>('#share-link'); input.value = url.href;
      $('#share-fallback').hidden = false;
      setShareStatus('shareCopyFailed'); input.focus(); input.select();
    }
  } catch (error) {
    if (current === shareGeneration) shareError(error);
  } finally {
    if (current === shareGeneration) { shareBusy = false; updateControls(); }
  }
});

window.addEventListener('pagehide', () => engine.dispose(), { once: true });
renderResult(); refreshLocale();
const startsWithShare = observedHash.startsWith('#s=');
if (startsWithShare) void restoreShare(observedHash);
void engine.ready.then(async () => {
  ready = true; updateControls();
  if (!startsWithShare && !restoring) await evaluate({ initial: inputLines(), operations: [] });
}).catch((error: unknown) => {
  failed = true; ready = false; showError(error); updateControls();
  setResultStatus('failed');
});
