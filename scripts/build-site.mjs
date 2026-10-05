// Copy the shared core into the website so GitHub Pages serves the exact code
// the Lambda functions run (docs/ is published as-is, no bundler).
//
//   node scripts/build-site.mjs          copy packages/core/src → docs/js/core
//   node scripts/build-site.mjs --check  fail if the copy differs (CI)

import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApi } from '../packages/core/src/api/app.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'packages/core/src');
const dst = join(root, 'docs/js/core');
const check = process.argv.includes('--check');

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const banner = '// Copied from packages/core/src by scripts/build-site.mjs — edit the original.\n';
let stale = 0;
for (const file of walk(src).filter((f) => f.endsWith('.js'))) {
  const rel = relative(src, file);
  const out = join(dst, rel);
  const want = banner + readFileSync(file, 'utf8');
  if (check) {
    if (!existsSync(out) || readFileSync(out, 'utf8') !== want) { console.error(`stale: docs/js/core/${rel}`); stale++; }
  } else {
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, want);
  }
}
const spec = JSON.stringify(openApi(), null, 2) + '\n';
const specPath = join(root, 'docs/openapi.json');
if (check) {
  if (!existsSync(specPath) || readFileSync(specPath, 'utf8') !== spec) { console.error('stale: docs/openapi.json'); stale++; }
  if (stale) process.exit(1);
  console.log('docs/js/core and docs/openapi.json are up to date');
} else {
  writeFileSync(specPath, spec);
  console.log('copied core → docs/js/core, wrote docs/openapi.json');
}
