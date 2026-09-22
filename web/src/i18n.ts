export type Locale = 'ja' | 'en';

let locale: Locale = document.documentElement.lang === 'en' ? 'en' : 'ja';
// Capture the deployment directory once. History navigation must not change
// where the shared Worker, Wasm and Go runtime are loaded from.
const pathname = window.location.pathname;
const basePath = locale === 'en'
  ? pathname.replace(/\/en(?:\/index\.html)?\/?$/, '/')
  : pathname.replace(/\/index\.html$/, '/').replace(/\/?$/, '/');
const baseURL = new URL(basePath, window.location.origin);

export function getLocale(): Locale { return locale; }
export function setLocale(value: Locale): void { locale = value; }
export function localeURL(value: Locale): URL { return new URL(value === 'en' ? 'en/' : './', baseURL); }
export function localeFromURL(): Locale {
  const path = window.location.pathname;
  const english = localeURL('en').pathname;
  return path === english || path === english.slice(0, -1) || path === `${english}index.html` ? 'en' : 'ja';
}
export function assetURL(path: string): URL { return new URL(path, baseURL); }
