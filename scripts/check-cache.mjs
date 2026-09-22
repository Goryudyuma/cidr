#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Check the actual hosting layer: Vite preview does not apply Cloudflare _headers.
// Run after deploying: node scripts/check-cache.mjs https://cidr.example.com/
const argument = process.argv[2];
if (!argument) throw new Error('Usage: node scripts/check-cache.mjs <deployment URL>');
const target = new URL(argument);
assert.ok(['http:', 'https:'].includes(target.protocol), 'Use an HTTP(S) deployment URL.');
const report = [];

async function request(url, headers = {}) {
  return fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
}

function cacheDirectives(response) {
  return new Set((response.headers.get('cache-control') ?? '').toLowerCase().split(',').map((value) => value.trim()));
}

async function checkResource(url, kind) {
  const first = await request(url);
  assert.equal(first.status, 200, `${url}: initial GET`);
  const body = Buffer.from(await first.arrayBuffer());
  assert.ok(body.length > 0, `${url}: missing resource body`);
  const etag = first.headers.get('etag');
  assert.ok(etag, `${url}: missing ETag; browser revalidation cannot use If-None-Match`);
  const directives = cacheDirectives(first);
  assert.ok(!directives.has('no-store'), `${url}: must allow storing a copy for revalidation`);
  if (kind === 'hashed') {
    assert.ok(directives.has('immutable') && directives.has('max-age=31536000'), `${url}: hashed assets must be immutable`);
  } else {
    assert.ok(directives.has('max-age=0') && directives.has('must-revalidate'), `${url}: must revalidate before reuse`);
    assert.ok(!directives.has('immutable'), `${url}: fixed resource names must not be immutable`);
  }

  const unchanged = await request(url, { 'If-None-Match': etag });
  assert.equal(unchanged.status, 304, `${url}: matching ETag must return 304`);
  assert.equal((await unchanged.arrayBuffer()).byteLength, 0, `${url}: 304 must not transfer a body`);

  // A deliberately nonmatching validator verifies the update branch without
  // claiming that a second deployment has taken place during this check.
  const stale = await request(url, { 'If-None-Match': `"not-current-${randomUUID()}"` });
  assert.equal(stale.status, 200, `${url}: nonmatching ETag must fetch the current resource`);
  assert.deepEqual(Buffer.from(await stale.arrayBuffer()), body, `${url}: must return the current resource body`);

  report.push({ path: new URL(first.url).pathname, kind, etag, unchanged: 304, nonmatching: 200 });
  return { body, url: first.url };
}

const document = await checkResource(target, 'document');
const html = document.body.toString('utf8');
assert.match(html, /<html\b/i, 'The deployment entry point must serve HTML.');
const assets = new Set();
for (const match of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
  const url = new URL(match[1], document.url);
  if (/\.(?:js|css)$/.test(url.pathname) && url.origin === target.origin) assets.add(url.href);
}
assert.ok(assets.size > 0, 'The deployed HTML must reference compiled JavaScript/CSS assets.');
for (const href of assets) {
  const url = new URL(href);
  assert.match(url.pathname, /\/assets\/[^/]+-[\w-]{6,}\.(?:js|css)$/, `${url}: expected a content-hashed filename`);
  const asset = await checkResource(url, 'hashed');
  // Vite emits the Worker URL into the main bundle rather than index.html.
  if (url.pathname.endsWith('.js')) {
    for (const match of asset.body.toString('utf8').matchAll(/["']([^"'\s]*worker-[\w-]+\.js)["']/g)) {
      const workerURL = new URL(match[1], asset.url);
      assert.equal(workerURL.origin, target.origin, 'The calculation Worker must be hosted with the UI.');
      assets.add(workerURL.href);
    }
  }
}

const wasm = await checkResource(new URL('wasm/core.wasm', document.url), 'wasm');
assert.deepEqual(wasm.body.subarray(0, 4), Buffer.from([0, 97, 115, 109]), 'Expected an actual Wasm module.');
await checkResource(new URL('wasm/wasm_exec.js', document.url), 'runtime');
console.log(JSON.stringify({ url: target.href, resources: report }, null, 2));
