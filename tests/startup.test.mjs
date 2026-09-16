import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { startPlayer } from '../js/startup.js';

for (const [name, gpu] of [
  ['missing API', undefined],
  ['no adapter', { requestAdapter: async () => null }],
  ['adapter rejection', { requestAdapter: async () => { throw new Error('disabled'); } }],
  ['adapter timeout', { requestAdapter: () => new Promise(() => {}) }],
]) {
  test(name + ' shows guidance without loading the player', async () => {
    let loaded = false;
    const reasons = [];
    assert.equal(await startPlayer({ gpu, timeoutMs: 5, loadPlayer: async () => { loaded = true; }, onUnavailable: reason => reasons.push(reason) }), false);
    assert.equal(loaded, false);
    assert.deepEqual(reasons, [gpu ? 'gpu' : 'unsupported']);
  });
}

test('available GPU starts playback without an error card', async () => {
  let loaded = 0;
  assert.equal(await startPlayer({ gpu: { requestAdapter: async () => ({}) }, loadPlayer: async () => { loaded++; }, onUnavailable: assert.fail }), true);
  assert.equal(loaded, 1);
});

for (const [name, reason] of [['WebGPUInitializationError', 'gpu'], ['TypeError', 'load']]) {
  test(name + ' is reported with the correct guidance', async t => {
    t.mock.method(console, 'error', () => {});
    const reasons = [];
    const error = new Error('Test failure'); error.name = name;
    assert.equal(await startPlayer({ gpu: { requestAdapter: async () => ({}) }, loadPlayer: async () => { throw error; }, onUnavailable: r => reasons.push(r) }), false);
    assert.deepEqual(reasons, [reason]);
  });
}

function bootstrap({ protocol = 'https:', copy = async () => {} } = {}) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { hidden: true, tagName: 'DIV', listeners: {}, addEventListener(name, cb) { this.listeners[name] = cb; }, focus() { this.focused = true; }, select() { this.selected = true; } });
    return elements.get(id);
  };
  const background = { tagName: 'DIV', setAttribute(name) { if (name === 'inert') this.inert = true; } };
  vm.runInNewContext(readFileSync(new URL('../js/bootstrap.js', import.meta.url), 'utf8'), {
    document: { getElementById: get, body: { children: [get('compat-modal'), background] } },
    navigator: { clipboard: { writeText: copy } }, window: { isSecureContext: true },
    location: { protocol }, console,
  });
  return { get, background };
}

test('unsupported screen disables background and focuses card', () => {
  const page = bootstrap();
  assert.equal(page.get('compat-modal').hidden, false);
  assert.equal(page.get('compat-title').focused, true);
  assert.equal(page.background.inert, true);
});

test('file preview explains how to open the hosted player', () => {
  assert.match(bootstrap({ protocol: 'file:' }).get('compat-description').textContent, /파일 미리보기/);
});

test('copy uses the public URL and gives a selectable fallback on failure', async () => {
  let copied;
  const success = bootstrap({ copy: async value => { copied = value; } });
  await success.get('compat-copy').listeners.click();
  assert.equal(copied, 'https://tomlim2.github.io/mmd-anju/');
  assert.match(success.get('compat-copy-status').textContent, /복사했어요/);
  const failure = bootstrap({ copy: async () => { throw new Error('clipboard blocked'); } });
  await failure.get('compat-copy').listeners.click();
  assert.equal(failure.get('compat-url').hidden, false);
  assert.equal(failure.get('compat-url').selected, true);
});
