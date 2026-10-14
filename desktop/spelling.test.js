const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const { suggest } = require('./spelling');

const load = Module._load;
Module._load = (request, ...rest) => (request === 'electron' ? { Menu: {}, clipboard: {} } : load(request, ...rest));
const { withSuggestions } = require('./context-menu');
Module._load = load;

test('swapped letters rank the intended word first', async () => {
  assert.equal((await suggest('teh'))[0], 'the');
  assert.equal((await suggest('adn'))[0], 'and');
  assert.equal((await suggest('hte'))[0], 'the');
  assert.equal((await suggest('recieve'))[0], 'receive');
});

test('keeps the capitalisation of a sentence-initial typo', async () => {
  assert.equal((await suggest('Teh'))[0], 'The');
});

test('falls back to dictionary suggestions when no swap fixes the word', async () => {
  assert.ok((await suggest('speling')).includes('spelling'));
  assert.ok((await suggest('chapterr')).includes('chapter'));
});

test('caps the list and has no duplicates', async () => {
  const words = await suggest('teh');
  assert.ok(words.length <= 6);
  assert.equal(new Set(words).size, words.length);
});

test('returns nothing for an empty word', async () => {
  assert.deepEqual(await suggest(''), []);
});

const misspelled = { isEditable: true, misspelledWord: 'teh', dictionarySuggestions: [] };

test('the menu uses the fallback only when the OS has no suggestions', async () => {
  const fallback = async () => ['the'];

  assert.deepEqual((await withSuggestions(misspelled, fallback)).dictionarySuggestions, ['the']);

  const fromOs = { ...misspelled, dictionarySuggestions: ['tech'] };
  assert.equal(await withSuggestions(fromOs, fallback), fromOs);
});

test('the menu skips the fallback when nothing is misspelled or the field is read-only', async () => {
  let called = false;
  const fallback = async () => { called = true; return ['x']; };

  await withSuggestions({ ...misspelled, misspelledWord: '' }, fallback);
  await withSuggestions({ ...misspelled, isEditable: false }, fallback);
  assert.equal(called, false);
});

test('a failing fallback still lets the menu open', async (t) => {
  t.mock.method(console, 'error', () => {});
  const result = await withSuggestions(misspelled, async () => { throw new Error('dictionary missing'); });
  assert.deepEqual(result.dictionarySuggestions, []);
});
