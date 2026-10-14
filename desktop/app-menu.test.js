const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildAppMenuTemplate, sanitizeModel, EMPTY_MODEL } = require('./app-menu');

const model = sanitizeModel({
  signedIn: true,
  navigation: [
    { id: 'resource-manager', label: 'Resource Manager' },
    { id: 'thoughts', label: 'Thoughts' },
    { id: 'entities', label: 'Entities' },
    { id: 'relationships', label: 'Relationships' },
    { id: 'maps', label: 'Maps' },
    { id: 'gallery', label: 'Photo Gallery' },
    { id: 'archived', label: 'Archived Items' },
    { id: 'generation-queue', label: 'Generation Queue' },
    { id: 'writing-stats', label: 'Writing Stats' },
    { id: 'extra', label: 'Tenth Item' },
  ],
  pageActions: [{ id: '0', label: 'Edit Chapter' }, { id: '1', label: 'Export' }],
  library: {
    loaded: true,
    series: [
      {
        id: 's1',
        title: 'Dust & Ash',
        books: [
          { id: 'b1', title: 'Book One', chapters: [{ id: 'c1', title: 'The Spice' }, { id: 'c2', title: 'A Storm' }] },
          { id: 'b2', title: 'Book Two', chapters: [] },
        ],
      },
      { id: 's2', title: 'Empty Series', books: [] },
    ],
  },
});

function build(m = model, options = {}) {
  const sent = [];
  const calls = { back: 0, forward: 0 };
  const template = buildAppMenuTemplate(
    m,
    { send: (c) => sent.push(c), goBack: () => calls.back++, goForward: () => calls.forward++ },
    { platform: 'darwin', ...options },
  );
  const menu = (label) => template.find((m) => m.label === label);
  const item = (submenu, label) => submenu.find((i) => i.label === label);
  return { template, sent, calls, menu, item };
}

const labels = (submenu) => submenu.map((i) => i.label ?? i.role ?? i.type);

test('macOS menu bar mirrors the explorer: Go, Page and Library beside the standard menus', () => {
  const { template } = build();
  assert.deepEqual(
    template.map((m) => m.label ?? m.role),
    ['Quill AI', 'File', 'editMenu', 'View', 'Go', 'Page', 'Library', 'windowMenu'],
  );
});

test('Windows has no app menu; Settings, Sign Out and Exit live in File', () => {
  const { template, menu } = build(model, { platform: 'win32' });
  assert.equal(template[0].label, 'File');
  assert.deepEqual(labels(menu('File').submenu), ['Settings', 'separator', 'Sign Out', 'separator', 'Exit']);
});

test('Settings sits in the macOS app menu with Cmd+,', () => {
  const { menu, item, sent } = build();
  const settings = item(menu('Quill AI').submenu, 'Settings…');
  assert.equal(settings.accelerator, 'CmdOrCtrl+,');
  settings.click();
  assert.deepEqual(sent, [{ type: 'navigate', id: 'settings' }]);
});

test('Go lists the explorer destinations in order with Cmd/Ctrl+1–9', () => {
  const { menu, sent } = build();
  const go = menu('Go').submenu;
  const destinations = go.slice(go.findIndex((i) => i.type === 'separator') + 1);

  assert.deepEqual(destinations.map((i) => i.label), model.navigation.map((n) => n.label));
  assert.deepEqual(destinations.slice(0, 3).map((i) => i.accelerator), ['CmdOrCtrl+1', 'CmdOrCtrl+2', 'CmdOrCtrl+3']);
  assert.equal(destinations[8].accelerator, 'CmdOrCtrl+9');
  assert.equal(destinations[9].accelerator, undefined);

  destinations[1].click();
  assert.deepEqual(sent, [{ type: 'navigate', id: 'thoughts' }]);
});

test('Go has Back, Forward and Home', () => {
  const { menu, item, sent, calls } = build();
  const go = menu('Go').submenu;
  item(go, 'Back').click();
  item(go, 'Forward').click();
  item(go, 'Home').click();
  assert.deepEqual(calls, { back: 1, forward: 1 });
  assert.deepEqual(sent, [{ type: 'home' }]);
});

test('View toggles the explorer', () => {
  const { menu, item, sent } = build();
  const explorer = item(menu('View').submenu, 'Explorer');
  assert.equal(explorer.accelerator, 'CmdOrCtrl+Shift+E');
  explorer.click();
  assert.deepEqual(sent, [{ type: 'toggle-explorer' }]);
});

test('developer tools appear only in development', () => {
  const roles = (b) => b.menu('View').submenu.map((i) => i.role);
  assert.ok(!roles(build()).includes('toggleDevTools'));
  assert.ok(roles(build(model, { isDev: true })).includes('toggleDevTools'));
});

test('Page lists the current page actions and runs them by id', () => {
  const { menu, sent } = build();
  const page = menu('Page').submenu;
  assert.deepEqual(labels(page), ['Edit Chapter', 'Export']);
  page[1].click();
  assert.deepEqual(sent, [{ type: 'page-action', id: '1' }]);
});

test('Page says so when the page has no actions', () => {
  const { menu } = build({ ...model, pageActions: [] });
  assert.deepEqual(menu('Page').submenu, [{ label: 'No actions on this page', enabled: false }]);
});

test('Library nests Series → Book → Chapter with Open entries', () => {
  const { menu, item, sent } = build();
  const library = menu('Library').submenu;
  assert.deepEqual(labels(library), ['Dust & Ash', 'Empty Series', 'separator', 'Refresh Library']);

  const series = library[0].submenu;
  assert.deepEqual(labels(series), ['Open Series', 'separator', 'Book One', 'Book Two']);
  const book = item(series, 'Book One').submenu;
  assert.deepEqual(labels(book), ['Open Book', 'separator', 'The Spice', 'A Storm']);

  item(series, 'Open Series').click();
  item(book, 'Open Book').click();
  item(book, 'A Storm').click();
  assert.deepEqual(sent, [
    { type: 'open', kind: 'series', id: 's1' },
    { type: 'open', kind: 'book', id: 'b1' },
    { type: 'open', kind: 'chapter', id: 'c2' },
  ]);
});

test('Library shows placeholders for empty series and books', () => {
  const { menu, item } = build();
  const library = menu('Library').submenu;
  assert.deepEqual(item(library, 'Empty Series').submenu.at(-1), { label: 'No books', enabled: false });
  assert.deepEqual(item(library[0].submenu, 'Book Two').submenu.at(-1), { label: 'No chapters', enabled: false });
});

test('Refresh Library asks the client to reload the tree', () => {
  const { menu, item, sent } = build();
  item(menu('Library').submenu, 'Refresh Library').click();
  assert.deepEqual(sent, [{ type: 'refresh-library' }]);
});

test('Library shows Loading… until the tree arrives, and No series yet when empty', () => {
  const loading = build({ ...model, library: { loaded: false, series: [] } }).menu('Library').submenu;
  assert.deepEqual(loading[0], { label: 'Loading…', enabled: false });
  const empty = build({ ...model, library: { loaded: true, series: [] } }).menu('Library').submenu;
  assert.deepEqual(empty[0], { label: 'No series yet', enabled: false });
});

test('signed out: app commands are disabled and the library asks you to sign in', () => {
  const { menu, item } = build(sanitizeModel({ ...model, signedIn: false }));
  assert.equal(item(menu('Quill AI').submenu, 'Settings…').enabled, false);
  assert.equal(item(menu('File').submenu, 'Sign Out').enabled, false);
  assert.equal(item(menu('View').submenu, 'Explorer').enabled, false);
  assert.equal(item(menu('Go').submenu, 'Home').enabled, false);
  assert.ok(menu('Go').submenu.filter((i) => i.accelerator?.match(/\+\d$/)).every((i) => i.enabled === false));
  assert.deepEqual(menu('Library').submenu[0], { label: 'Sign in to see your library', enabled: false });
  assert.equal(item(menu('Library').submenu, 'Refresh Library').enabled, false);
});

test('titles are shortened, blank titles read Untitled, and & is escaped on Windows', () => {
  const long = 'A'.repeat(120);
  const m = sanitizeModel({
    signedIn: true,
    library: { loaded: true, series: [{ id: 's', title: long, books: [] }, { id: 't', title: '  ', books: [] }, { id: 'u', title: 'Salt & Iron', books: [] }] },
  });
  const mac = build(m).menu('Library').submenu;
  assert.equal(mac[0].label.length, 80);
  assert.ok(mac[0].label.endsWith('…'));
  assert.equal(mac[1].label, 'Untitled');
  assert.equal(mac[2].label, 'Salt & Iron');
  assert.equal(build(m, { platform: 'win32' }).menu('Library').submenu[2].label, 'Salt && Iron');
});

test('sanitizeModel turns malformed input into an empty, signed-out menu', () => {
  assert.equal(sanitizeModel(null), EMPTY_MODEL);
  assert.equal(sanitizeModel('nope'), EMPTY_MODEL);
  assert.deepEqual(sanitizeModel({ signedIn: 'yes', navigation: 'x', library: { series: [{ id: 's', books: 'x' }] } }), {
    signedIn: false,
    navigation: [],
    pageActions: [],
    library: { loaded: false, series: [{ id: 's', title: '', books: [] }] },
  });
});

test('sanitizeModel drops entries without an id or label', () => {
  const m = sanitizeModel({
    signedIn: true,
    navigation: [{ id: 'a', label: 'A' }, { id: '', label: 'B' }, { id: 'c' }],
    library: {
      loaded: true,
      series: [
        { id: 5, title: 'Numeric id' },
        { id: 's', title: 'S', books: [{ title: 'No id' }, { id: 'b', title: 'B', chapters: [{ title: 'x' }, { id: 'c', title: 'C' }] }] },
      ],
    },
  });
  assert.deepEqual(m.navigation, [{ id: 'a', label: 'A' }]);
  assert.deepEqual(m.library.series, [{ id: 's', title: 'S', books: [{ id: 'b', title: 'B', chapters: [{ id: 'c', title: 'C' }] }] }]);
});
