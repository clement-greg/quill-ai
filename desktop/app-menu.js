// The native menu bar, laid out like the web app's explorer drawer:
//
//   Go      — the explorer's destinations (Resource Manager, Thoughts, …)
//   Page    — the current page's actions (the explorer's top section)
//   Library — the Series → Book → Chapter tree
//
// plus the platform's usual app/File/Edit/View/Window menus. The client owns
// the content and sends it as a model (client/src/app/core/desktop); clicks go
// back to it as commands, since only the client can navigate or run actions.

const MAX_TITLE = 80;
const MAX_ITEMS = 500;

/** The menu before the client has reported anything (or for an older hosted client). */
const EMPTY_MODEL = Object.freeze({
  signedIn: false,
  navigation: [],
  pageActions: [],
  library: { loaded: false, series: [] },
});

const str = (value) => (typeof value === 'string' ? value : '');
const hasId = (n) => n.id !== '';
const list = (value) => (Array.isArray(value) ? value.slice(0, MAX_ITEMS) : []);

/** Coerces what the page sent into the expected shape; anything malformed becomes empty. */
function sanitizeModel(raw) {
  if (!raw || typeof raw !== 'object') return EMPTY_MODEL;
  const item = (i) => ({ id: str(i?.id), label: str(i?.label) });
  const node = (n, children) => ({ id: str(n?.id), title: str(n?.title), ...children });
  return {
    signedIn: raw.signedIn === true,
    navigation: list(raw.navigation).map(item).filter((i) => i.id && i.label),
    pageActions: list(raw.pageActions).map(item).filter((i) => i.id && i.label),
    library: {
      loaded: raw.library?.loaded === true,
      series: list(raw.library?.series)
        .map((s) =>
          node(s, {
            books: list(s?.books)
              .map((b) => node(b, { chapters: list(b?.chapters).map((c) => node(c, {})).filter(hasId) }))
              .filter(hasId),
          }),
        )
        .filter(hasId),
    },
  };
}

/** Makes user-supplied text safe as a menu label. */
function labelFor(text, platform) {
  const trimmed = text.trim() || 'Untitled';
  const short = trimmed.length > MAX_TITLE ? `${trimmed.slice(0, MAX_TITLE - 1)}…` : trimmed;
  // Windows and Linux read "&" as a mnemonic marker; "&&" shows a literal ampersand.
  return platform === 'darwin' ? short : short.replace(/&/g, '&&');
}

function libraryMenu(model, send, platform) {
  const { signedIn, library } = model;
  const disabled = (label) => [{ label, enabled: false }];

  let items;
  if (!signedIn) items = disabled('Sign in to see your library');
  else if (!library.loaded) items = disabled('Loading…');
  else if (!library.series.length) items = disabled('No series yet');
  else {
    items = library.series.map((series) => ({
      label: labelFor(series.title, platform),
      submenu: [
        { label: 'Open Series', click: () => send({ type: 'open', kind: 'series', id: series.id }) },
        { type: 'separator' },
        ...(series.books.length
          ? series.books.map((book) => ({
              label: labelFor(book.title, platform),
              submenu: [
                { label: 'Open Book', click: () => send({ type: 'open', kind: 'book', id: book.id }) },
                { type: 'separator' },
                ...(book.chapters.length
                  ? book.chapters.map((chapter) => ({
                      label: labelFor(chapter.title, platform),
                      click: () => send({ type: 'open', kind: 'chapter', id: chapter.id }),
                    }))
                  : disabled('No chapters')),
              ],
            }))
          : disabled('No books')),
      ],
    }));
  }

  return {
    label: 'Library',
    submenu: [
      ...items,
      { type: 'separator' },
      { label: 'Refresh Library', enabled: signedIn, click: () => send({ type: 'refresh-library' }) },
    ],
  };
}

/**
 * Builds the application menu template. Pure apart from the click handlers, so
 * the layout can be tested without Electron.
 *
 * @param model     sanitized menu model from the client
 * @param handlers  { send(command), goBack(), goForward() }
 * @param options   { platform, isDev, appName }
 */
function buildAppMenuTemplate(model, handlers, { platform = process.platform, isDev = false, appName = 'Quill AI' } = {}) {
  const { send, goBack, goForward } = handlers;
  const isMac = platform === 'darwin';
  const { signedIn } = model;

  const settings = {
    label: isMac ? 'Settings…' : 'Settings',
    accelerator: 'CmdOrCtrl+,',
    enabled: signedIn,
    click: () => send({ type: 'navigate', id: 'settings' }),
  };
  const signOut = { label: 'Sign Out', enabled: signedIn, click: () => send({ type: 'sign-out' }) };

  const appMenu = {
    label: appName,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      settings,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };

  const fileMenu = {
    label: 'File',
    submenu: isMac
      ? [signOut, { type: 'separator' }, { role: 'close' }]
      : [settings, { type: 'separator' }, signOut, { type: 'separator' }, { role: 'quit', label: 'Exit' }],
  };

  const viewMenu = {
    label: 'View',
    submenu: [
      { label: 'Explorer', accelerator: 'CmdOrCtrl+Shift+E', enabled: signedIn, click: () => send({ type: 'toggle-explorer' }) },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'forceReload' },
      ...(isDev ? [{ role: 'toggleDevTools' }] : []),
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const goMenu = {
    label: 'Go',
    submenu: [
      { label: 'Back', accelerator: 'CmdOrCtrl+[', click: goBack },
      { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: goForward },
      { label: 'Home', accelerator: 'CmdOrCtrl+Shift+H', enabled: signedIn, click: () => send({ type: 'home' }) },
      { type: 'separator' },
      // The explorer's order is stable, so its first nine entries get Cmd/Ctrl+1–9.
      ...model.navigation.map((item, i) => ({
        label: item.label,
        accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined,
        enabled: signedIn,
        click: () => send({ type: 'navigate', id: item.id }),
      })),
    ],
  };

  const pageMenu = {
    label: 'Page',
    submenu: model.pageActions.length
      ? model.pageActions.map((action) => ({
          label: labelFor(action.label, platform),
          click: () => send({ type: 'page-action', id: action.id }),
        }))
      : [{ label: 'No actions on this page', enabled: false }],
  };

  return [
    ...(isMac ? [appMenu] : []),
    fileMenu,
    { role: 'editMenu' },
    viewMenu,
    goMenu,
    pageMenu,
    libraryMenu(model, send, platform),
    { role: 'windowMenu' },
  ];
}

module.exports = { buildAppMenuTemplate, sanitizeModel, EMPTY_MODEL };
