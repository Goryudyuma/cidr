import './style.css';
import { Engine } from './engine';
import type { Operation, Request, Result } from './types';
import { Visualization } from './visualization';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="app-shell">
    <header class="site-header">
      <a class="brand" href="./" aria-label="CIDR Studio ホーム"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><span>CIDR<span class="brand-light"> Studio</span></span></a>
      <div id="engine-status" class="engine-status" role="status" data-state="loading"><span class="status-dot"></span><span id="engine-status-text">計算エンジンを読み込み中</span></div>
    </header>

    <main>
      <div class="page-heading">
        <div><p class="eyebrow">IP ADDRESS WORKSPACE</p><h1>アドレスの集合を、見渡す。</h1><p class="page-description">IP・CIDRを追加、除外して、必要な範囲だけに整理します。</p></div>
        <button id="reset-set" class="button button-quiet" type="button" disabled><span aria-hidden="true">↺</span> すべてリセット</button>
      </div>
      <div id="error-banner" class="error-banner" role="alert" hidden></div>

      <div class="workspace">
        <aside class="editor-column" aria-label="集合の編集">
          <section class="panel input-panel">
            <div class="section-heading"><div><span class="step-number">01</span><h2>初期集合</h2></div><button id="load-example" class="text-button" type="button" disabled>サンプル</button></div>
            <label for="initial-input" class="field-label">IP / CIDR <span>1行に1件</span></label>
            <textarea id="initial-input" spellcheck="false" autocomplete="off" rows="7" aria-describedby="initial-help" placeholder="192.0.2.0/24&#10;2001:db8::/120">192.0.2.0/24
2001:db8::/120</textarea>
            <p id="initial-help" class="field-help">IPv4・IPv6を混在できます。適用すると操作履歴も初期化します。</p>
            <button id="apply-initial" class="button button-primary full-width" type="button" disabled>初期集合を適用 <span aria-hidden="true">→</span></button>
            <p id="draft-status" class="draft-status" aria-live="polite"></p>
          </section>

          <section class="panel operation-panel">
            <div class="section-heading"><div><span class="step-number">02</span><h2>集合を編集</h2></div></div>
            <label for="operation-input" class="field-label">追加・除外する IP / CIDR</label>
            <input id="operation-input" class="mono-input" spellcheck="false" autocomplete="off" placeholder="192.0.2.64/26" aria-describedby="operation-help" />
            <div class="operation-buttons"><button id="add-operation" class="button button-add" type="button" disabled><span aria-hidden="true">＋</span> 追加</button><button id="remove-operation" class="button button-remove" type="button" disabled><span aria-hidden="true">−</span> 除外</button></div>
            <p id="operation-help" class="field-help">操作は上から順に適用されます。除外した範囲も、あとから追加できます。</p>
            <div class="history-heading"><h3>操作履歴</h3><span id="operation-count" class="count-badge">0</span></div>
            <ol id="operation-history" class="operation-history"></ol>
            <div id="history-pagination" class="pagination" hidden></div>
          </section>
          <p class="local-note"><span class="local-icon" aria-hidden="true">◈</span><span>計算はこのブラウザ内で完結します。<br>入力したアドレスは送信されません。</span></p>
        </aside>

        <div class="result-column">
          <section class="stats" aria-label="集合の集計">
            <div class="stat"><span class="stat-label"><span class="family-dot ipv4"></span>IPv4 アドレス数</span><strong id="count-ipv4" class="stat-value">0</strong><span class="stat-unit">addresses</span></div>
            <div class="stat"><span class="stat-label"><span class="family-dot ipv6"></span>IPv6 アドレス数</span><strong id="count-ipv6" class="stat-value">0</strong><span class="stat-unit">addresses</span></div>
            <div class="stat stat-compact"><span class="stat-label">最小CIDR</span><strong id="cidr-count" class="stat-value">0</strong><span class="stat-unit">prefixes</span></div>
          </section>

          <section class="panel visualization-panel" aria-labelledby="visualization-heading">
            <div class="visualization-heading"><div><span class="eyebrow">ADDRESS SPACE</span><h2 id="visualization-heading">集合の見取り図</h2></div><div class="segmented-control" aria-label="表示範囲"><button id="view-fit" type="button" class="active" aria-pressed="true">集合に合わせる</button><button id="view-all" type="button" aria-pressed="false">全体 /0</button></div></div>
            <form id="zoom-form" class="zoom-form"><label for="zoom-input">表示範囲</label><input id="zoom-input" class="mono-input" placeholder="IP / CIDRを指定してズーム" spellcheck="false" autocomplete="off" /><button id="zoom-submit" class="button button-quiet" type="submit" disabled>ズーム <span aria-hidden="true">↗</span></button></form>
            <p id="zoom-error" class="inline-error" role="alert" hidden></p>
            <div id="visualization"></div>
            <div class="plot-legend"><span><i class="legend-band"></i>集合に含む範囲</span><span><i class="legend-marker"></i>表示幅より小さい範囲</span><span>両端のアドレスを含みます</span></div>
          </section>

          <section class="panel output-panel" aria-label="計算結果">
            <div class="output-heading"><div class="output-tabs" role="tablist" aria-label="結果の形式"><button id="tab-cidrs" class="active" type="button" role="tab" aria-selected="true" aria-controls="cidrs-panel">最小CIDR <span id="cidr-tab-count" class="count-badge">0</span></button><button id="tab-ranges" type="button" role="tab" aria-selected="false" aria-controls="ranges-panel" tabindex="-1">連続範囲 <span id="range-tab-count" class="count-badge">0</span></button></div><button id="copy-cidrs" class="text-button" type="button" disabled>コピー <span aria-hidden="true">⧉</span></button></div>
            <div id="cidrs-panel" role="tabpanel" aria-labelledby="tab-cidrs"><div class="output-table-heading"><span>NETWORK / PREFIX</span><span>FAMILY</span></div><ol id="cidr-list" class="cidr-list"></ol><div id="cidr-pagination" class="pagination" hidden></div></div>
            <div id="ranges-panel" role="tabpanel" aria-labelledby="tab-ranges" hidden><div class="output-table-heading"><span>START → END（両端を含む）</span><span>FAMILY</span></div><ol id="range-list" class="range-list"></ol><div id="range-pagination" class="pagination" hidden></div></div>
            <div class="output-footer"><span id="result-status" role="status">計算エンジンの準備を待っています</span><span id="copy-status" role="status"></span></div>
          </section>
        </div>
      </div>
    </main>
    <footer class="site-footer"><span>CIDR Studio</span><span>IPv4 + IPv6 <span aria-hidden="true">/</span> 集合演算・CIDR集約</span></footer>
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

function inputLines(): string[] { return initialInput.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); }
function isDraft(): boolean { return JSON.stringify(inputLines()) !== JSON.stringify(initial); }
function groupedInteger(value: string): string { return value.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

function updateControls(): void {
  for (const id of ['#apply-initial', '#load-example']) $<HTMLButtonElement>(id).disabled = !ready || busy;
  for (const id of ['#add-operation', '#remove-operation']) $<HTMLButtonElement>(id).disabled = !ready || busy || isDraft() || !operationInput.value.trim();
  $<HTMLButtonElement>('#reset-set').disabled = !ready;
  $<HTMLButtonElement>('#zoom-submit').disabled = !ready || !zoomInput.value.trim();
  $<HTMLButtonElement>('#copy-cidrs').disabled = !ready || result.cidrs.length === 0;
  $('#draft-status').textContent = ready && isDraft() ? '初期集合に未適用の変更があります。' : '';
  const status = $('#engine-status');
  status.dataset.state = failed ? 'failed' : busy || !ready ? 'loading' : 'ready';
  $('#engine-status-text').textContent = failed ? '計算エンジンを利用できません' : !ready ? '計算エンジンを読み込み中' : busy ? '集合を計算中' : 'ローカル計算・準備完了';
}

function errorDescription(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const detail = error as Error & { code?: string; field?: string };
  return `${detail.message}${detail.field ? ` · ${detail.field}` : ''}${detail.code ? ` [${detail.code}]` : ''}`;
}

function showError(error: unknown): void {
  errorBanner.textContent = errorDescription(error);
  errorBanner.hidden = false;
}

function clearError(): void { errorBanner.hidden = true; errorBanner.textContent = ''; }

function invalidatePending(): void {
  generation++;
  zoomGeneration++;
  if (busy) resultStatus.textContent = '入力が変更されたため、計算結果の反映を取り消しました';
  busy = false;
  updateControls();
}

async function evaluate(request: Request, afterCommit?: () => void): Promise<void> {
  const current = ++generation;
  zoomGeneration++;
  busy = true;
  clearError();
  resultStatus.textContent = '計算中…';
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
    resultStatus.textContent = `計算完了 · ${Math.max(1, Math.round(performance.now() - started)).toLocaleString()} ms`;
  } catch (error) {
    if (current !== generation) return;
    showError(error);
    resultStatus.textContent = '入力を確認してください。集合は更新されていません。';
  } finally {
    if (current === generation) { busy = false; updateControls(); }
  }
}

function renderPagination(container: HTMLElement, count: number, page: number, size: number, onChange: (page: number) => void): void {
  container.replaceChildren();
  container.hidden = count <= size;
  if (container.hidden) return;
  const previous = document.createElement('button'); previous.type = 'button'; previous.textContent = '← 前へ'; previous.disabled = page === 0;
  previous.addEventListener('click', () => onChange(page - 1));
  const label = document.createElement('span'); label.textContent = `${page * size + 1}–${Math.min((page + 1) * size, count)} / ${count.toLocaleString()}`;
  const next = document.createElement('button'); next.type = 'button'; next.textContent = '次へ →'; next.disabled = (page + 1) * size >= count;
  next.addEventListener('click', () => onChange(page + 1));
  container.append(previous, label, next);
}

function emptyRow(text: string): HTMLLIElement {
  const row = document.createElement('li'); row.className = 'empty-row'; row.textContent = text; return row;
}

function renderHistory(): void {
  $('#operation-count').textContent = operations.length.toLocaleString();
  const list = $('#operation-history'); list.replaceChildren();
  if (operations.length === 0) list.append(emptyRow('操作はまだありません'));
  for (const [index, operation] of operations.slice(historyPage * historyPageSize, (historyPage + 1) * historyPageSize).entries()) {
    const row = document.createElement('li');
    const number = document.createElement('span'); number.className = 'history-index'; number.textContent = String(historyPage * historyPageSize + index + 1).padStart(2, '0');
    const action = document.createElement('span'); action.className = `operation-badge ${operation.op}`; action.textContent = operation.op === 'add' ? '追加' : '除外';
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
  if (result.cidrs.length === 0) list.append(emptyRow('集合は空です。IPまたはCIDRを追加してください。'));
  for (const cidr of result.cidrs.slice(cidrPage * pageSize, (cidrPage + 1) * pageSize)) {
    const row = document.createElement('li'); const value = document.createElement('code'); value.textContent = cidr;
    row.append(value, familyLabel(cidr)); list.append(row);
  }
  renderPagination($('#cidr-pagination'), result.cidrs.length, cidrPage, pageSize, (page) => { cidrPage = page; renderCidrs(); });
}

function renderRanges(): void {
  const list = $('#range-list'); list.replaceChildren();
  if (result.ranges.length === 0) list.append(emptyRow('集合に含まれる範囲はありません。'));
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
  $('#cidr-count').textContent = result.cidrs.length.toLocaleString();
  $('#cidr-tab-count').textContent = result.cidrs.length.toLocaleString();
  $('#range-tab-count').textContent = result.ranges.length.toLocaleString();
  renderHistory(); renderCidrs(); renderRanges(); visualization.setResult(result);
}

initialInput.addEventListener('input', invalidatePending);
operationInput.addEventListener('input', invalidatePending);
zoomInput.addEventListener('input', () => { zoomGeneration++; $('#zoom-error').hidden = true; updateControls(); });
$('#apply-initial').addEventListener('click', () => { void evaluate({ initial: inputLines(), operations: [] }); });

for (const op of ['add', 'remove'] as const) {
  $(`#${op}-operation`).addEventListener('click', () => {
    const value = operationInput.value.trim();
    if (!value || !ready || busy || isDraft()) return;
    void evaluate({ initial, operations: [...operations, { op, value }] }, () => { operationInput.value = ''; });
  });
}

$('#reset-set').addEventListener('click', () => {
  initialInput.value = ''; operationInput.value = ''; zoomInput.value = '';
  $('#zoom-error').hidden = true;
  visualization.setMode('fit'); setViewButton('fit');
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
  $(`#view-${mode}`).addEventListener('click', () => { zoomGeneration++; visualization.setMode(mode); setViewButton(mode); $('#zoom-error').hidden = true; });
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
    zoomError.textContent = errorDescription(error); zoomError.hidden = false;
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
  try { await navigator.clipboard.writeText(result.cidrs.join('\n')); $('#copy-status').textContent = 'CIDR一覧をコピーしました'; }
  catch { $('#copy-status').textContent = 'コピーできませんでした。一覧から選択してコピーしてください。'; }
});

window.addEventListener('pagehide', () => engine.dispose(), { once: true });
renderResult(); updateControls();
void engine.ready.then(async () => {
  ready = true; updateControls();
  await evaluate({ initial: inputLines(), operations: [] });
}).catch((error: unknown) => {
  failed = true; ready = false; showError(error); updateControls();
  resultStatus.textContent = '計算エンジンを起動できませんでした。ページを再読み込みしてください。';
});
