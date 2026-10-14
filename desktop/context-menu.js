// Electron shows no context menu on its own, so right-clicking a misspelling in
// the chapter editor did nothing even though the spellchecker underlines it.
// This rebuilds the browser's menu: spelling suggestions, then edit commands.
//
// Pages that handle `contextmenu` themselves (folder, photo and card menus)
// call preventDefault, and Electron doesn't raise `context-menu` for those.

const { Menu, clipboard } = require('electron');
const spelling = require('./spelling');

/**
 * Builds the menu template for a `context-menu` event. Pure apart from the
 * click handlers, so the shape can be tested without Electron.
 */
function buildContextMenuTemplate(params, webContents, { isDev = false } = {}) {
  const { misspelledWord, dictionarySuggestions = [], isEditable, selectionText, editFlags = {}, linkURL } = params;
  const sections = [];

  if (isEditable && misspelledWord) {
    const spelling = dictionarySuggestions.length
      ? dictionarySuggestions.map((word) => ({ label: word, click: () => webContents.replaceMisspelling(word) }))
      : [{ label: 'No Guesses Found', enabled: false }];
    spelling.push({
      label: 'Add to Dictionary',
      click: () => webContents.session.addWordToSpellCheckerDictionary(misspelledWord),
    });
    sections.push(spelling);
  }

  if (isEditable) {
    sections.push([
      { role: 'cut', enabled: !!editFlags.canCut },
      { role: 'copy', enabled: !!editFlags.canCopy },
      { role: 'paste', enabled: !!editFlags.canPaste },
      { role: 'pasteAndMatchStyle', enabled: !!editFlags.canPaste },
    ]);
    sections.push([{ role: 'selectAll', enabled: !!editFlags.canSelectAll }]);
  } else if (selectionText?.trim()) {
    sections.push([{ role: 'copy', enabled: !!editFlags.canCopy }]);
  }

  if (linkURL) {
    sections.push([{ label: 'Copy Link', click: () => clipboard.writeText(linkURL) }]);
  }

  if (isDev) {
    sections.push([{ label: 'Inspect Element', click: () => webContents.inspectElement(params.x, params.y) }]);
  }

  return sections.flatMap((section, i) => (i === 0 ? section : [{ type: 'separator' }, ...section]));
}

/** Fills in suggestions the OS spellchecker left empty (see spelling.js). */
async function withSuggestions(params, suggest) {
  if (!params.isEditable || !params.misspelledWord || params.dictionarySuggestions?.length) return params;
  try {
    return { ...params, dictionarySuggestions: await suggest(params.misspelledWord) };
  } catch (err) {
    console.error('[context-menu] fallback spelling suggestions failed:', err);
    return params;
  }
}

function attachContextMenu(webContents, options) {
  webContents.on('context-menu', async (_event, params) => {
    const template = buildContextMenuTemplate(await withSuggestions(params, spelling.suggest), webContents, options);
    if (template.length) Menu.buildFromTemplate(template).popup();
  });
}

module.exports = { attachContextMenu, buildContextMenuTemplate, withSuggestions };
