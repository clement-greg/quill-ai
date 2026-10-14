const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// google-sign-in.js only needs electron's shell.openExternal; capture the URL it opens.
let opened = [];
const load = Module._load;
Module._load = (request, ...rest) =>
  request === 'electron' ? { shell: { openExternal: (url) => opened.push(new URL(url)) } } : load(request, ...rest);
const { signInWithGoogle } = require('./google-sign-in');
Module._load = load;

beforeEach(() => {
  opened = [];
});

async function start(origin = 'https://quill.example') {
  const before = opened.length;
  const result = signInWithGoogle(origin);
  // Settle the rejection immediately so a test that never resolves it doesn't trip unhandled-rejection.
  result.catch(() => {});
  while (opened.length === before) await new Promise((r) => setTimeout(r, 5));
  const url = opened.at(-1);
  return {
    result,
    url,
    state: url.searchParams.get('desktopState'),
    callback: `http://127.0.0.1:${url.searchParams.get('desktopPort')}/callback`,
  };
}

const post = (url, fields) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });

test('opens the app login page in the system browser with a port and state', async () => {
  const { url, state, callback, result } = await start('https://quill.example');

  assert.equal(url.origin, 'https://quill.example');
  assert.equal(url.pathname, '/login');
  assert.match(url.searchParams.get('desktopPort'), /^\d+$/);
  assert.match(state, /^[0-9a-f]{48}$/);

  await post(callback, { credential: 'token', state });
  await result;
});

test('resolves with the credential and shows a done page', async () => {
  const { state, callback, result } = await start();

  const res = await post(callback, { credential: 'google-id-token', state });

  assert.equal(res.status, 200);
  assert.match(await res.text(), /You're signed in/);
  assert.equal(await result, 'google-id-token');
});

test('rejects a callback with the wrong state and keeps waiting', async () => {
  const { state, callback, result } = await start();

  const bad = await post(callback, { credential: 'forged', state: 'not-the-state' });
  assert.equal(bad.status, 400);

  const good = await post(callback, { credential: 'google-id-token', state });
  assert.equal(good.status, 200);
  assert.equal(await result, 'google-id-token');
});

test('rejects a callback with no credential', async () => {
  const { state, callback, result } = await start();

  assert.equal((await post(callback, { state })).status, 400);

  await post(callback, { credential: 'google-id-token', state });
  await result;
});

test('only answers POST /callback', async () => {
  const { state, callback, result } = await start();

  assert.equal((await fetch(callback)).status, 404);
  assert.equal((await post(callback.replace('/callback', '/other'), { state })).status, 404);

  await post(callback, { credential: 'google-id-token', state });
  await result;
});

test('closes the listener once sign-in completes', async () => {
  const { state, callback, result } = await start();
  await post(callback, { credential: 'google-id-token', state });
  await result;

  await assert.rejects(post(callback, { credential: 'again', state }));
});

test('a new attempt supersedes one left unfinished', async () => {
  const first = await start();
  const second = await start();

  await assert.rejects(first.result, /Superseded/);
  await assert.rejects(post(first.callback, { credential: 'late', state: first.state }));

  await post(second.callback, { credential: 'google-id-token', state: second.state });
  assert.equal(await second.result, 'google-id-token');
});
