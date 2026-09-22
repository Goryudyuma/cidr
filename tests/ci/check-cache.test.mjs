import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../../scripts/check-cache.mjs', import.meta.url));
const mainPath = '/assets/main-abc12345.js';
const cssPath = '/assets/main-css12345.css';
const workerPath = '/assets/worker-def67890.js';
const wasmPath = '/wasm/core.wasm';
const runtimePath = '/wasm/wasm_exec.js';
const expectedPaths = ['/', '/en/', mainPath, cssPath, workerPath, wasmPath, runtimePath].sort();

function resource(path, version) {
  let body;
  if (path === '/' || path === '/en/') {
    const language = path === '/' ? 'ja' : 'en';
    body = `<html lang="${language}"><head><script src="${mainPath}"></script><link href="${cssPath}"></head><body>revision ${version}</body></html>`;
  } else if (path === mainPath) {
    // Oxc emits backtick-delimited Worker URLs in the actual Vite 8 bundle.
    body = `new Worker(new URL(\`worker-def67890.js\`, import.meta.url)); // revision ${version}`;
  } else if (path === cssPath) {
    body = `body { color: #123; } /* revision ${version} */`;
  } else if (path === workerPath) {
    body = `self.onmessage = () => {}; // revision ${version}`;
  } else if (path === wasmPath) {
    // A minimal Wasm module with a custom section identifying the revision.
    body = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0, 2, 1, 97 + version]);
  } else if (path === runtimePath) {
    body = `globalThis.Go = class {}; // revision ${version}`;
  } else {
    return undefined;
  }
  return { body: Buffer.from(body), etag: JSON.stringify(`${path}:v${version}`) };
}

async function fixture(context, intercept = () => undefined) {
  const state = { version: 0, switched: false, requests: [] };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const validator = request.headers['if-none-match'];
    const override = intercept({ path, validator, state }) ?? {};
    const hashed = path.startsWith('/assets/');
    const current = resource(path, override.version ?? (hashed ? 0 : state.version));
    if (!current) {
      response.writeHead(404).end();
      return;
    }
    const etag = override.etag ?? current.etag;
    const status = override.status ?? (validator === etag ? 304 : 200);
    state.requests.push({ path, validator, status, etag });
    response.writeHead(status, {
      ETag: etag,
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
    });
    response.end(status === 304 ? undefined : (override.body ?? current.body));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { state, url: `http://127.0.0.1:${address.port}/` };
}

async function runCheck(url) {
  const child = spawn(process.execPath, [script, url], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15_000);
  try {
    const outcome = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(timedOut, false, `Cache check did not finish within 15 seconds:\n${stderr}`);
    return { ...outcome, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

function initialGets(state, path) {
  return state.requests.filter((request) => request.path === path && request.validator === undefined);
}

function successReport(result) {
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.resources.length, 7);
  assert.deepEqual(report.resources.map((entry) => entry.path).sort(), expectedPaths);
  for (const entry of report.resources) {
    assert.equal(entry.unchanged, 304);
    assert.equal(entry.nonmatching, 200);
  }
  return report;
}

test('checks all seven stable resources, including a backtick-delimited Worker URL', async (context) => {
  const { url, state } = await fixture(context);
  const result = await runCheck(url);
  successReport(result);
  assert.equal(state.requests.length, 21);
  assert.equal(initialGets(state, '/').length, 1);
  assert.equal(initialGets(state, workerPath).length, 1);
  assert.equal(result.stderr, '');
});

test('retries the document requests when it changes before its matching ETag request', async (context) => {
  const { url, state } = await fixture(context, ({ path, validator, state }) => {
    if (path === '/' && validator === resource('/', 0).etag && !state.switched) {
      state.switched = true;
      state.version = 1;
    }
  });
  const result = await runCheck(url);
  const report = successReport(result);
  assert.equal(state.switched, true);
  assert.equal(initialGets(state, '/').length, 2);
  assert.equal(report.resources.find((entry) => entry.path === '/').etag, resource('/', 1).etag);
  assert.match(result.stderr, /retry|changed|deployment|transition|version/i);
});

test('retries only Wasm when it changes before its deliberately stale ETag request', async (context) => {
  const { url, state } = await fixture(context, ({ path, validator, state }) => {
    if (path === wasmPath && validator?.startsWith('"not-current-') && !state.switched) {
      state.switched = true;
      state.version = 1;
    }
  });
  const result = await runCheck(url);
  const report = successReport(result);
  assert.equal(state.switched, true);
  assert.equal(initialGets(state, '/').length, 1);
  assert.equal(initialGets(state, wasmPath).length, 2);
  assert.equal(report.resources.find((entry) => entry.path === '/').etag, resource('/', 0).etag);
  assert.equal(report.resources.find((entry) => entry.path === wasmPath).etag, resource(wasmPath, 1).etag);
  assert.match(result.stderr, /retry|changed|deployment|transition|version/i);
});

test('fails without retrying when a matching ETag returns 200 with the same representation', async (context) => {
  const { url, state } = await fixture(context, ({ path, validator }) => {
    if (path === '/' && validator === resource('/', 0).etag) return { status: 200 };
  });
  const result = await runCheck(url);
  assert.notEqual(result.code, 0);
  assert.equal(initialGets(state, '/').length, 1);
  assert.equal(state.requests.length, 2);
});

for (const changedPart of ['etag', 'body']) {
  test(`does not treat a changed ${changedPart} alone as a new deployment`, async (context) => {
    const { url, state } = await fixture(context, ({ path, validator }) => {
      if (path === '/' && validator === resource('/', 0).etag) {
        return { status: 200, [changedPart]: resource('/', 1)[changedPart] };
      }
    });
    const result = await runCheck(url);
    assert.notEqual(result.code, 0);
    assert.equal(initialGets(state, '/').length, 1);
    assert.equal(state.requests.length, 2);
  });
}

for (const phase of ['matching', 'stale']) {
  test(`fails without retrying if an immutable JavaScript file changes during the ${phase} request`, async (context) => {
    const { url, state } = await fixture(context, ({ path, validator }) => {
      const triggered = phase === 'matching'
        ? validator === resource(mainPath, 0).etag
        : validator?.startsWith('"not-current-');
      if (path === mainPath && triggered) return { version: 1 };
    });
    const result = await runCheck(url);
    assert.notEqual(result.code, 0);
    assert.equal(initialGets(state, '/').length, 1);
    assert.equal(initialGets(state, mainPath).length, 1);
    assert.equal(state.requests.filter((request) => request.path === mainPath).length, phase === 'matching' ? 2 : 3);
  });
}
