// Fallback spelling suggestions for the context menu.
//
// macOS's spellchecker flags some words without offering any guesses — notably
// common typos it would rather autocorrect, like "teh" — so the menu showed
// "No Guesses Found". When the OS comes back empty we ask a bundled Hunspell
// English dictionary instead.
//
// Hunspell ranks by edit distance alone, which buries the obvious fix for a
// transposition ("teh" → ten, eh, meh, …, the). Swapped letters are the most
// common typing slip, so those candidates go first.

const nspell = require('nspell');

const MAX_SUGGESTIONS = 6;

let spellPromise = null;

/** Loads the dictionary on first use (~40ms); the menu is the only caller. */
function loadSpell() {
  spellPromise ??= import('dictionary-en').then(({ default: dictionary }) => nspell(dictionary));
  return spellPromise;
}

function transpositions(word, spell) {
  const found = [];
  for (let i = 0; i < word.length - 1; i++) {
    const swapped = word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
    if (swapped !== word && spell.correct(swapped) && !found.includes(swapped)) found.push(swapped);
  }
  return found;
}

function rankSuggestions(word, spell) {
  const ranked = [...transpositions(word, spell)];
  for (const suggestion of spell.suggest(word)) {
    if (!ranked.includes(suggestion)) ranked.push(suggestion);
  }
  return ranked.slice(0, MAX_SUGGESTIONS);
}

async function suggest(word) {
  if (!word) return [];
  return rankSuggestions(word, await loadSpell());
}

module.exports = { suggest, rankSuggestions };
