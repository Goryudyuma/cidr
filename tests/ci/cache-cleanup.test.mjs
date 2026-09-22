import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Exercise the exact inline script without executing privileged GitHub requests.
const workflow = readFileSync(
  new URL('../../.github/workflows/cache-cleanup.yml', import.meta.url),
  'utf8',
);
const script = workflow.split('          script: |\n')[1].replace(/^ {12}/gm, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction('github', 'context', 'core', script);

function harness({ caches = [], states = {}, eventName = 'schedule', payload = {}, deleteError } = {}) {
  const deleted = [];
  const requestedPulls = [];
  const context = { repo: { owner: 'owner', repo: 'repo' }, eventName, payload };
  const rest = {
    actions: {
      getActionsCacheList() {},
      async deleteActionsCacheById({ cache_id }) {
        deleted.push(cache_id);
        if (deleteError) throw deleteError;
      },
    },
    pulls: {
      async get({ pull_number }) {
        requestedPulls.push(pull_number);
        const state = states[pull_number];
        if (state instanceof Error) throw state;
        assert.ok(state, `Unexpected PR lookup: ${pull_number}`);
        return { data: { state } };
      },
    },
  };
  const github = {
    rest,
    async paginate(method, options) {
      assert.equal(method, rest.actions.getActionsCacheList);
      assert.deepEqual(options, { owner: 'owner', repo: 'repo', per_page: 100 });
      return caches;
    },
  };
  return {
    deleted,
    requestedPulls,
    run: () => execute(github, context, { info() {} }),
  };
}

test('daily cleanup preserves branch and open PR caches and handles both PR ref forms', async () => {
  const subject = harness({
    caches: [
      { id: 1, ref: 'refs/heads/main' },
      { id: 2, ref: 'refs/heads/feature' },
      { id: 3, ref: 'refs/pull/10/merge' },
      { id: 4, ref: 'refs/pull/20/merge' },
      { id: 5, ref: 'refs/pull/20/head' },
      { id: 6, ref: 'refs/pull/30/merge/extra' },
      { id: 7, ref: 'refs/pull/9007199254740993/merge' },
      { id: 8, ref: 'refs/pull/40/merge' },
    ],
    states: { 10: 'open', 20: 'closed', 40: 'closed' },
  });
  await subject.run();
  assert.deepEqual(subject.deleted, [4, 5, 8]);
  assert.deepEqual(subject.requestedPulls, [10, 20, 40]);
});

test('closed PR event deletes only the matching PR caches', async () => {
  const subject = harness({
    eventName: 'pull_request_target',
    payload: { action: 'closed', pull_request: { number: 20 } },
    caches: [{ id: 1, ref: 'refs/pull/20/merge' }, { id: 2, ref: 'refs/pull/30/merge' }],
    states: { 20: 'closed' },
  });
  await subject.run();
  assert.deepEqual(subject.deleted, [1]);
  assert.deepEqual(subject.requestedPulls, [20]);
});

test('a PR reopened after the event keeps its cache', async () => {
  const subject = harness({
    eventName: 'pull_request_target',
    payload: { action: 'closed', pull_request: { number: 20 } },
    caches: [{ id: 1, ref: 'refs/pull/20/merge' }],
    states: { 20: 'open' },
  });
  await subject.run();
  assert.deepEqual(subject.deleted, []);
});

test('missing PR records are skipped without deleting caches', async () => {
  const subject = harness({
    eventName: 'workflow_dispatch',
    caches: [{ id: 1, ref: 'refs/pull/20/merge' }],
    states: { 20: Object.assign(new Error('Not found'), { status: 404 }) },
  });
  await subject.run();
  assert.deepEqual(subject.deleted, []);
});

test('404 deletion races are harmless', async () => {
  const subject = harness({
    caches: [{ id: 1, ref: 'refs/pull/20/merge' }],
    states: { 20: 'closed' },
    deleteError: Object.assign(new Error('Not found'), { status: 404 }),
  });
  await subject.run();
  assert.deepEqual(subject.deleted, [1]);
});

test('unexpected API failures fail the workflow instead of hiding them', async () => {
  const failure = Object.assign(new Error('Forbidden'), { status: 403 });
  for (const phase of ['read', 'delete']) {
    const subject = harness({
      caches: [{ id: 1, ref: 'refs/pull/20/merge' }],
      states: { 20: phase === 'read' ? failure : 'closed' },
      deleteError: phase === 'delete' ? failure : undefined,
    });
    await assert.rejects(subject.run(), failure);
  }
});

test('invalid PR event numbers are rejected before GitHub requests', async () => {
  for (const number of [undefined, 0, -1, '20', '20; command', 1.5]) {
    const subject = harness({
      eventName: 'pull_request_target',
      payload: { action: 'closed', pull_request: { number } },
    });
    await assert.rejects(subject.run(), /valid number/);
    assert.deepEqual(subject.deleted, []);
    assert.deepEqual(subject.requestedPulls, []);
  }
});
