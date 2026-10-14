// Regenerates src/fonts/material-symbols-outlined.woff2 with only the icons
// the client uses (see used-icons.mjs). Run after adding a new icon:
//
//   pip install fonttools brotli
//   npm run icons:subset
//
// It also writes material-symbols-icons.json, the list the font was cut to;
// a unit test fails when source uses an icon that isn't in it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAMES_FILE, usedIconNames } from './used-icons.mjs';

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(clientDir, 'node_modules/material-symbols/material-symbols-outlined.woff2');
const fontsDir = path.join(clientDir, 'src/fonts');
const output = path.join(fontsDir, 'material-symbols-outlined.woff2');
const manifest = path.join(fontsDir, 'material-symbols-icons.json');

function python(...args) {
  try {
    execFileSync('python3', [path.join(clientDir, 'scripts/subset-icons.py'), ...args], { stdio: 'inherit' });
  } catch {
    console.error('Subsetting failed. It needs fonttools: pip install fonttools brotli');
    process.exit(1);
  }
}

python('names', source, NAMES_FILE);
const names = usedIconNames();
fs.mkdirSync(fontsDir, { recursive: true });
fs.writeFileSync(manifest, JSON.stringify(names, null, 2) + '\n');
python('subset', source, output, manifest);

console.log(`${names.length} icons, ${(fs.statSync(output).size / 1024).toFixed(1)} KB → ${path.relative(clientDir, output)}`);
