import type { IPRange, Result } from './types';
import { getLocale, type Locale } from './i18n';
import type { SharedView } from './share';

export type Family = 'ipv4' | 'ipv6';
type NumericRange = { source: IPRange; index: number; start: bigint; end: bigint };
type ViewportLabel = { kind: 'custom'; text: string } | { kind: 'selected' };
type Viewport = { start: bigint; end: bigint; label: ViewportLabel | { kind: 'fit' } };
type ZoomViewport = Viewport & { label: ViewportLabel };
type PrefixBounds = { text: string; family: Family; start: bigint; end: bigint };
type VisualizationMessages = {
  detailLabel: string;
  fitToSet: string;
  selectedRange: string;
  rangeCount: (visible: number, total: number) => string;
  spaceDescription: (family: string) => string;
  emptySpace: string;
  emptyViewport: string;
  rangeDescription: (start: string, end: string, groupSize?: number) => string;
  rangeTitle: (start: string, end: string, groupSize?: number) => string;
  detailHint: string;
  markerHint: string;
  detailTitle: (family: string, index: number, groupSize?: number) => string;
  zoomToRange: string;
  start: string;
  end: string;
  relatedCIDRs: (count: number) => string;
  previous: string;
  next: string;
};
const number = (value: number): string => value.toLocaleString(getLocale() === 'ja' ? 'ja-JP' : 'en-US');
const messages: Record<Locale, VisualizationMessages> = {
  ja: {
    detailLabel: '範囲の詳細',
    fitToSet: '集合に合わせる',
    selectedRange: '選択した範囲',
    rangeCount: (visible, total) => `${number(visible)} / ${number(total)} 範囲`,
    spaceDescription: (family) => `${family} アドレス空間。帯を選択すると詳細を表示します。`,
    emptySpace: 'このアドレス空間は空です',
    emptyViewport: '表示範囲内にアドレスはありません',
    rangeDescription: (start, end, groupSize) => `${start} から ${end}${groupSize && groupSize > 1 ? `、同じ位置に ${number(groupSize)} 範囲。矢印キーで選択` : ''}`,
    rangeTitle: (start, end, groupSize) => `${start} – ${end}${groupSize && groupSize > 1 ? ` (${number(groupSize)} 範囲が重なっています。選択後に矢印キーで切り替え)` : ''}`,
    detailHint: '帯にカーソルを合わせるか、選択すると範囲の詳細を確認できます。',
    markerHint: '細いマーカーも集合の一部です。同じ位置に重なる範囲は、選択後に矢印キーで切り替えられます。',
    detailTitle: (family, index, groupSize) => `${family} · 範囲 ${number(index)}${groupSize && groupSize > 1 ? ` · 同じ位置に ${number(groupSize)} 範囲` : ''}`,
    zoomToRange: 'この範囲を拡大 ↗',
    start: '開始',
    end: '終了',
    relatedCIDRs: (count) => `関連CIDR (${number(count)})`,
    previous: '前へ',
    next: '次へ',
  },
  en: {
    detailLabel: 'Range details',
    fitToSet: 'Fit to set',
    selectedRange: 'Selected range',
    rangeCount: (visible, total) => `${number(visible)} / ${number(total)} ${total === 1 ? 'range' : 'ranges'}`,
    spaceDescription: (family) => `${family} address space. Select a band to view its details.`,
    emptySpace: 'This address space is empty',
    emptyViewport: 'No addresses in the visible range',
    rangeDescription: (start, end, groupSize) => `${start} to ${end}${groupSize && groupSize > 1 ? `, ${number(groupSize)} ranges at the same position. Use the arrow keys to select a range.` : ''}`,
    rangeTitle: (start, end, groupSize) => `${start} – ${end}${groupSize && groupSize > 1 ? ` (${number(groupSize)} overlapping ranges. Select and use the arrow keys to switch ranges.)` : ''}`,
    detailHint: 'Hover over or select a band to view the range details.',
    markerHint: 'Thin markers are also part of the set. Select overlapping ranges and use the arrow keys to switch between them.',
    detailTitle: (family, index, groupSize) => `${family} · Range ${number(index)}${groupSize && groupSize > 1 ? ` · ${number(groupSize)} ranges at the same position` : ''}`,
    zoomToRange: 'Zoom to range ↗',
    start: 'Start',
    end: 'End',
    relatedCIDRs: (count) => `Related CIDRs (${number(count)})`,
    previous: 'Previous',
    next: 'Next',
  },
};
const SVG_NS = 'http://www.w3.org/2000/svg';
const WIDTH = 1000;
const LEFT = 12;
const RIGHT = 988;
const SCALE = BigInt((RIGHT - LEFT) * 1000);
const familyMax: Record<Family, bigint> = {
  ipv4: (1n << 32n) - 1n,
  ipv6: (1n << 128n) - 1n,
};

/** Parse only addresses already normalized and validated by the Go core. */
export function addressInteger(address: string): bigint {
  if (!address.includes(':')) {
    return address.split('.').reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
  }
  // Go may render a normalized mapped endpoint with a dotted suffix.
  let expanded = address;
  if (expanded.includes('.')) {
    const lastColon = expanded.lastIndexOf(':');
    const tail = addressInteger(expanded.slice(lastColon + 1));
    expanded = `${expanded.slice(0, lastColon)}:${(tail >> 16n).toString(16)}:${(tail & 65535n).toString(16)}`;
  }
  const [left, right] = expanded.split('::');
  const first = left ? left.split(':') : [];
  const last = right ? right.split(':') : [];
  const parts = right === undefined ? first : [...first, ...Array<string>(8 - first.length - last.length).fill('0'), ...last];
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function addressText(value: bigint, family: Family): string {
  if (family === 'ipv4') {
    return [24n, 16n, 8n, 0n].map((shift) => ((value >> shift) & 255n).toString()).join('.');
  }
  const parts = Array.from({ length: 8 }, (_, index) => ((value >> BigInt((7 - index) * 16)) & 65535n).toString(16));
  let longestStart = -1;
  let longestLength = 1;
  for (let index = 0; index < parts.length;) {
    if (parts[index] !== '0') { index++; continue; }
    let end = index;
    while (end < parts.length && parts[end] === '0') end++;
    if (end - index > longestLength) { longestStart = index; longestLength = end - index; }
    index = end;
  }
  return longestStart < 0 ? parts.join(':') : `${parts.slice(0, longestStart).join(':')}::${parts.slice(longestStart + longestLength).join(':')}`;
}

function prefixBounds(text: string): PrefixBounds {
  const [address, bits] = text.split('/');
  const family = address.includes(':') ? 'ipv6' : 'ipv4';
  const start = addressInteger(address);
  return { text, family, start, end: start + (1n << BigInt((family === 'ipv4' ? 32 : 128) - Number(bits))) - 1n };
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string>): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

export class Visualization {
  private ranges: NumericRange[] = [];
  private prefixes: Record<Family, PrefixBounds[]> = { ipv4: [], ipv6: [] };
  private viewports: Partial<Record<Family, ZoomViewport>> = {};
  private mode: 'fit' | 'all' = 'fit';
  private selected: number | undefined;
  private hover: number | undefined;
  private relatedPage = 0;
  private marks: { element: SVGRectElement; first: number; last: number }[] = [];
  private readonly detail: HTMLElement;
  private readonly panels: Record<Family, HTMLElement>;

  constructor(private readonly host: HTMLElement, private readonly onZoom?: () => void) {
    host.innerHTML = `
      <div id="plot-ipv4" class="family-panel" data-family="ipv4"></div>
      <div id="plot-ipv6" class="family-panel" data-family="ipv6"></div>
      <div id="range-detail" class="range-detail"></div>`;
    this.panels = { ipv4: host.querySelector<HTMLElement>('#plot-ipv4')!, ipv6: host.querySelector<HTMLElement>('#plot-ipv6')! };
    this.detail = host.querySelector<HTMLElement>('#range-detail')!;
    this.detail.setAttribute('aria-label', messages[getLocale()].detailLabel);
  }

  /** Repaint translations without resetting the selection, zoom, or CIDR page. */
  refreshLocale(): void { this.render(); }

  exportView(): SharedView {
    const viewports: SharedView['viewports'] = {};
    for (const family of ['ipv4', 'ipv6'] as const) {
      const view = this.viewports[family];
      if (view) {
        viewports[family] = {
          start: view.start.toString(),
          end: view.end.toString(),
          label: { ...view.label },
        };
      }
    }
    return {
      mode: this.mode,
      viewports,
      ...(this.selected === undefined ? {} : { selected: this.selected }),
      relatedPage: this.relatedPage,
    };
  }

  /** Restore decoded view data after setResult has supplied the recomputed set. */
  restoreView(state: SharedView): void {
    const viewports: Partial<Record<Family, ZoomViewport>> = {};
    for (const family of ['ipv4', 'ipv6'] as const) {
      const view = state.viewports[family];
      if (view) {
        viewports[family] = {
          start: BigInt(view.start),
          end: BigInt(view.end),
          label: { ...view.label },
        };
      }
    }
    this.mode = state.mode;
    this.viewports = viewports;
    const selected = state.selected;
    this.selected = selected !== undefined && Number.isSafeInteger(selected) && selected >= 0 && selected < this.ranges.length
      ? selected : undefined;
    this.hover = undefined;
    this.relatedPage = this.selected !== undefined && Number.isSafeInteger(state.relatedPage)
      ? Math.max(0, state.relatedPage) : 0;
    this.render();
  }

  setResult(result: Result): void {
    this.ranges = result.ranges.map((source, index) => ({ source, index, start: addressInteger(source.start), end: addressInteger(source.end) }));
    this.prefixes = { ipv4: [], ipv6: [] };
    for (const text of result.cidrs) {
      const prefix = prefixBounds(text);
      this.prefixes[prefix.family].push(prefix);
    }
    this.selected = undefined;
    this.hover = undefined;
    this.relatedPage = 0;
    this.render();
  }

  setMode(mode: 'fit' | 'all'): void {
    this.mode = mode;
    this.viewports = {};
    this.render();
  }

  zoom(range: IPRange, label: string): void {
    this.applyZoom(range, { kind: 'custom', text: label });
  }

  private applyZoom(range: IPRange, label: ViewportLabel): void {
    this.viewports[range.family] = { start: addressInteger(range.start), end: addressInteger(range.end), label };
    this.onZoom?.();
    this.render();
  }

  select(index: number): void {
    this.selected = index;
    this.hover = undefined;
    this.relatedPage = 0;
    this.renderDetail();
    this.updateSelectedMarks();
  }

  private viewport(family: Family, ranges: NumericRange[]): Viewport {
    const custom = this.viewports[family];
    if (custom) return custom;
    if (this.mode === 'all' || ranges.length === 0) return { start: 0n, end: familyMax[family], label: { kind: 'custom', text: `${family === 'ipv4' ? '0.0.0.0' : '::'}/0` } };
    const start = ranges[0].start;
    const end = ranges[ranges.length - 1].end;
    const span = end - start + 1n;
    const margin = span / 20n || 1n;
    return { start: start > margin ? start - margin : 0n, end: end + margin < familyMax[family] ? end + margin : familyMax[family], label: { kind: 'fit' } };
  }

  private render(): void {
    this.marks = [];
    for (const family of ['ipv4', 'ipv6'] as const) this.renderFamily(family);
    this.renderDetail();
  }

  private renderFamily(family: Family): void {
    const text = messages[getLocale()];
    const panel = this.panels[family];
    const ranges = this.ranges.filter((range) => range.source.family === family);
    const view = this.viewport(family, ranges);
    const visible = ranges.filter((range) => range.end >= view.start && range.start <= view.end);
    panel.replaceChildren();
    const header = document.createElement('div');
    header.className = 'family-heading';
    const heading = document.createElement('h3');
    heading.innerHTML = `<span class="family-dot ${family}"></span>${family === 'ipv4' ? 'IPv4' : 'IPv6'}`;
    const label = document.createElement('span');
    label.className = 'viewport-label';
    label.textContent = view.label.kind === 'custom' ? view.label.text : view.label.kind === 'fit' ? text.fitToSet : text.selectedRange;
    const count = document.createElement('span');
    count.className = 'family-range-count';
    count.textContent = text.rangeCount(visible.length, ranges.length);
    header.append(heading, label, count);
    const chart = svg('svg', { viewBox: `0 0 ${WIDTH} 84`, class: `range-plot ${family}`, 'aria-label': text.spaceDescription(family === 'ipv4' ? 'IPv4' : 'IPv6'), role: 'group' });
    chart.append(svg('rect', { x: String(LEFT), y: '15', width: String(RIGHT - LEFT), height: '38', rx: '5', class: 'plot-track' }));
    for (let index = 0; index <= 8; index++) {
      const x = LEFT + (RIGHT - LEFT) * index / 8;
      chart.append(svg('line', { x1: String(x), x2: String(x), y1: '11', y2: '61', class: 'plot-grid' }));
    }
    const span = view.end - view.start + 1n;
    // Values remain BigInt until reduced to a bounded, relative screen coordinate.
    const position = (address: bigint): number => LEFT + Number(((address - view.start) * SCALE) / span) / 1000;
    const tinyGroups = new Map<number, NumericRange[]>();
    for (const range of visible) {
      const clippedStart = range.start < view.start ? view.start : range.start;
      const clippedEnd = range.end > view.end ? view.end : range.end;
      const x = position(clippedStart);
      const width = position(clippedEnd + 1n) - x;
      if (width < 3) {
        const bucket = Math.min(RIGHT - 1, Math.max(LEFT, Math.floor(x)));
        const group = tinyGroups.get(bucket) ?? [];
        group.push(range);
        tinyGroups.set(bucket, group);
      } else {
        this.addMark(chart, range, x, width);
      }
    }
    for (const [x, group] of tinyGroups) this.addMark(chart, group[0], x, 3, group);
    if (visible.length === 0) {
      const empty = svg('text', { x: '500', y: '39', 'text-anchor': 'middle', class: 'plot-empty' });
      empty.textContent = ranges.length === 0 ? text.emptySpace : text.emptyViewport;
      chart.append(empty);
    }
    const axis = document.createElement('div');
    axis.className = 'plot-axis';
    for (const value of [view.start, view.end]) {
      const text = document.createElement('span');
      text.textContent = addressText(value, family);
      axis.append(text);
    }
    panel.append(header, chart, axis);
  }

  private addMark(chart: SVGSVGElement, range: NumericRange, x: number, width: number, group?: NumericRange[]): void {
    const text = messages[getLocale()];
    const first = range.index;
    const last = group?.[group.length - 1].index ?? first;
    const mark = svg('rect', {
      x: String(x), y: width <= 3 ? '11' : '20', width: String(width), height: width <= 3 ? '46' : '28', rx: width <= 3 ? '1' : '3',
      class: `range-band${this.selected !== undefined && this.selected >= first && this.selected <= last ? ' selected' : ''}${group ? ' range-marker' : ''}`,
      role: 'button', tabindex: '0', 'data-range-index': String(range.index),
      'aria-label': text.rangeDescription(range.source.start, range.source.end, group?.length),
    });
    const title = svg('title', {});
    title.textContent = text.rangeTitle(range.source.start, range.source.end, group?.length);
    mark.append(title);
    let groupIndex = group ? Math.max(0, group.findIndex((item) => item.index === this.selected)) : 0;
    const currentIndex = () => group?.[groupIndex].index ?? first;
    const selectCurrent = () => this.select(currentIndex());
    mark.addEventListener('click', selectCurrent);
    mark.addEventListener('mouseenter', () => { this.hover = currentIndex(); this.relatedPage = 0; this.renderDetail(group?.length); });
    mark.addEventListener('mouseleave', () => { this.hover = undefined; this.relatedPage = 0; this.renderDetail(); });
    mark.addEventListener('focus', () => { this.hover = currentIndex(); this.renderDetail(group?.length); });
    mark.addEventListener('blur', () => { this.hover = undefined; this.renderDetail(); });
    mark.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectCurrent(); }
      if (group && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        groupIndex = (groupIndex + (event.key === 'ArrowRight' ? 1 : group.length - 1)) % group.length;
        selectCurrent();
      }
    });
    this.marks.push({ element: mark, first, last });
    chart.append(mark);
  }

  private updateSelectedMarks(): void {
    for (const { element, first, last } of this.marks) {
      element.classList.toggle('selected', this.selected !== undefined && this.selected >= first && this.selected <= last);
    }
  }

  private renderDetail(groupSize?: number): void {
    const text = messages[getLocale()];
    const index = this.hover ?? this.selected;
    const range = index === undefined ? undefined : this.ranges[index];
    this.detail.replaceChildren();
    this.detail.setAttribute('aria-label', text.detailLabel);
    if (!range) {
      this.detail.innerHTML = `<span class="detail-symbol" aria-hidden="true">↗</span><p>${text.detailHint}<small>${text.markerHint}</small></p>`;
      return;
    }
    const title = document.createElement('div');
    title.className = 'detail-title';
    const label = document.createElement('strong');
    label.textContent = text.detailTitle(range.source.family === 'ipv4' ? 'IPv4' : 'IPv6', range.index + 1, groupSize);
    const zoom = document.createElement('button');
    zoom.type = 'button';
    zoom.className = 'text-button';
    zoom.textContent = text.zoomToRange;
    zoom.addEventListener('click', () => this.applyZoom(range.source, { kind: 'selected' }));
    title.append(label, zoom);
    const bounds = document.createElement('dl');
    bounds.className = 'detail-bounds';
    for (const [name, value] of [[text.start, range.source.start], [text.end, range.source.end]]) {
      const dt = document.createElement('dt'); dt.textContent = name;
      const dd = document.createElement('dd'); dd.textContent = value;
      bounds.append(dt, dd);
    }
    const prefixes = this.prefixes[range.source.family];
    // Prefixes are disjoint and sorted by the Go core. Find only the relevant
    // window so hovering remains cheap even for very large output lists.
    const bound = (after: (prefix: PrefixBounds) => boolean): number => {
      let low = 0;
      let high = prefixes.length;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (after(prefixes[middle])) high = middle;
        else low = middle + 1;
      }
      return low;
    };
    const firstRelated = bound((prefix) => prefix.end >= range.start);
    const endRelated = bound((prefix) => prefix.start > range.end);
    const relatedCount = endRelated - firstRelated;
    const cidrs = document.createElement('div');
    cidrs.className = 'related-cidrs';
    const caption = document.createElement('span');
    caption.textContent = text.relatedCIDRs(relatedCount);
    cidrs.append(caption);
    const pageSize = 32;
    const maxPage = Math.max(0, Math.ceil(relatedCount / pageSize) - 1);
    this.relatedPage = Math.min(this.relatedPage, maxPage);
    for (const prefix of prefixes.slice(firstRelated + this.relatedPage * pageSize, Math.min(firstRelated + (this.relatedPage + 1) * pageSize, endRelated))) {
      const code = document.createElement('code'); code.textContent = prefix.text; cidrs.append(code);
    }
    if (maxPage > 0) {
      const previous = document.createElement('button'); previous.type = 'button'; previous.textContent = text.previous; previous.disabled = this.relatedPage === 0;
      previous.addEventListener('click', () => { this.relatedPage--; this.renderDetail(); });
      const next = document.createElement('button'); next.type = 'button'; next.textContent = text.next; next.disabled = this.relatedPage === maxPage;
      next.addEventListener('click', () => { this.relatedPage++; this.renderDetail(); });
      cidrs.append(previous, document.createTextNode(`${this.relatedPage + 1} / ${maxPage + 1}`), next);
    }
    this.detail.append(title, bounds, cidrs);
  }
}
