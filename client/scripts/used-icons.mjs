// Finds the Material Symbols icons the client uses, so the icon font can be
// cut down to just those glyphs (the full font is ~4 MB).
//
// Icons are ligatures: <mat-icon>rate_review</mat-icon> renders the glyph named
// "rate_review". Many names are dynamic ({{ item.icon }}), so rather than parse
// templates we take every icon-shaped word that appears in source — string
// literals plus <mat-icon> text — and keep the ones that are real icon names.
// Over-including a few common words costs a few KB; missing one shows text.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every icon name the full font understands, read from its ligature table by
 * subset-icons.mjs. (material-symbols' index.d.ts omits legacy aliases such as
 * "expand_more", which the font still renders.)
 */
export const NAMES_FILE = path.join(clientDir, 'scripts/material-symbols-names.json');

export function allIconNames() {
  return new Set(JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8')));
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|html)$/.test(entry.name) && !entry.name.endsWith('.spec.ts') ? [full] : [];
  });
}

/** Sorted names of the icons referenced anywhere under client/src. */
export function usedIconNames() {
  const known = allIconNames();
  const used = new Set();
  for (const file of sourceFiles(path.join(clientDir, 'src'))) {
    const text = fs.readFileSync(file, 'utf8');
    const words = [
      ...[...text.matchAll(/(['"`])([a-z0-9_]+)\1/g)].map(m => m[2]),
      ...[...text.matchAll(/<mat-icon\b[^>]*>\s*([a-z0-9_]+)\s*</g)].map(m => m[1]),
    ];
    for (const word of words) if (known.has(word)) used.add(word);
  }
  return [...used].sort();
}

/** Icons used in source but missing from the subset font, which would render as text. */
export function iconsMissingFromSubset() {
  const manifest = path.join(clientDir, 'src/fonts/material-symbols-icons.json');
  const inFont = new Set(JSON.parse(fs.readFileSync(manifest, 'utf8')));
  return usedIconNames().filter(name => !inFont.has(name));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const missing = iconsMissingFromSubset();
    if (missing.length) {
      console.error(`Icons missing from the subset font: ${missing.join(', ')}\nRun: npm run icons:subset`);
      process.exit(1);
    }
  } else {
    console.log(usedIconNames().join('\n'));
  }
}
