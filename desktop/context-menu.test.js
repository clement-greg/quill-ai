const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const copied = [];
const load = Module._load;
Module._load = (request, ...rest) =>
  request === 'electron' ? { Menu: {}, clipboard: { writeText: (t) => copied.push(t) } } : load(request, ...rest);
const { buildContextMenuTemplate } = require('./context-menu');
Module._load = load;

function fakeWebContents() {
  const calls = { replaced: [], added: [], inspected: [] };
  return {
    calls,
    replaceMisspelling: (word) => calls.replaced.push(word),
    inspectElement: (x, y) => calls.inspected.push([x, y]),
    session: { addWordToSpellCheckerDictionary: (word) => calls.added.push(word) },
  };
}

const allEdits = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };
const labels = (template) => template.map((item) => item.label ?? item.role ?? item.type);

test('a misspelling in the editor offers suggestions, Add to Dictionary, then edit commands', () => {
  const wc = fakeWebContents();
  const template = buildContextMenuTemplate(
    { isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tech'], editFlags: allEdits },
    wc,
  );

  assert.deepEqual(labels(template), [
    'the', 'tech', 'Add to Dictionary',
    'separator', 'cut', 'copy', 'paste', 'pasteAndMatchStyle',
    'separator', 'selectAll',
  ]);
});

test('choosing a suggestion replaces the misspelled word', () => {
  const wc = fakeWebContents();
  const template = buildContextMenuTemplate(
    { isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the'], editFlags: allEdits },
    wc,
  );

  template.find((i) => i.label === 'the').click();
  assert.deepEqual(wc.calls.replaced, ['the']);
});

test('Add to Dictionary adds the misspelled word to the session dictionary', () => {
  const wc = fakeWebContents();
  const template = buildContextMenuTemplate(
    { isEditable: true, misspelledWord: 'Quilly', dictionarySuggestions: ['Quill'], editFlags: allEdits },
    wc,
  );

  template.find((i) => i.label === 'Add to Dictionary').click();
  assert.deepEqual(wc.calls.added, ['Quilly']);
});

test('a misspelling with no suggestions says so, still offering Add to Dictionary', () => {
  const template = buildContextMenuTemplate(
    { isEditable: true, misspelledWord: 'Xyzzyq', dictionarySuggestions: [], editFlags: allEdits },
    fakeWebContents(),
  );

  assert.equal(template[0].label, 'No Guesses Found');
  assert.equal(template[0].enabled, false);
  assert.equal(template[1].label, 'Add to Dictionary');
});

test('a correctly spelled word in the editor shows only edit commands', () => {
  const template = buildContextMenuTemplate({ isEditable: true, misspelledWord: '', editFlags: allEdits }, fakeWebContents());

  assert.equal(labels(template)[0], 'cut');
  assert.ok(!labels(template).includes('Add to Dictionary'));
});

test('edit commands follow what the page says is possible', () => {
  const template = buildContextMenuTemplate(
    { isEditable: true, editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } },
    fakeWebContents(),
  );
  const byRole = Object.fromEntries(template.filter((i) => i.role).map((i) => [i.role, i.enabled]));

  assert.deepEqual(byRole, { cut: false, copy: false, paste: true, pasteAndMatchStyle: true, selectAll: true });
});

test('selected read-only text offers Copy only', () => {
  const template = buildContextMenuTemplate(
    { isEditable: false, selectionText: 'some prose', editFlags: { canCopy: true } },
    fakeWebContents(),
  );

  assert.deepEqual(labels(template), ['copy']);
});

test('a link offers Copy Link', () => {
  const template = buildContextMenuTemplate(
    { isEditable: false, selectionText: '', linkURL: 'https://example.com/a', editFlags: {} },
    fakeWebContents(),
  );

  assert.deepEqual(labels(template), ['Copy Link']);
  template[0].click();
  assert.equal(copied.at(-1), 'https://example.com/a');
});

test('plain page background shows nothing', () => {
  assert.deepEqual(buildContextMenuTemplate({ isEditable: false, selectionText: '  ', editFlags: {} }, fakeWebContents()), []);
});

test('Inspect Element appears only in development', () => {
  const wc = fakeWebContents();
  const params = { isEditable: false, selectionText: '', editFlags: {}, x: 10, y: 20 };

  assert.deepEqual(buildContextMenuTemplate(params, wc), []);
  const dev = buildContextMenuTemplate(params, wc, { isDev: true });
  assert.deepEqual(labels(dev), ['Inspect Element']);
  dev[0].click();
  assert.deepEqual(wc.calls.inspected, [[10, 20]]);
});
