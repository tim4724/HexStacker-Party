#!/usr/bin/env node
'use strict';

// Down-level every .js under the given dir(s) to ES2017, in place.
//
// The AirConsole ZIP (scripts/build-airconsole.sh) ships raw source loaded as
// individual <script> tags — unlike the web app, whose bundle is already
// esbuild-transpiled (scripts/build.js buildApp, target es2017). Without this
// pass, ES2020 syntax (optional chaining `?.`, nullish coalescing `??`) reaches
// older AirConsole client engines and throws `SyntaxError: Unexpected token '.'`.
// A failed parse then leaves the globals that file defines undefined, cascading
// into ReferenceErrors in dependent scripts. Keep TARGET in lockstep with the
// web bundle target in scripts/build.js so the two packagings can't drift.
//
// Syntax-only lowering (no minify): the goal is engine compatibility, not size,
// so the transform's behavioral surface stays minimal. This lowers *syntax*
// only — es2019+ runtime APIs (Array.flat, String.replaceAll, …) are not
// polyfilled; the shipped source is kept free of them by convention.

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const TARGET = 'es2017'; // keep in lockstep with scripts/build.js

async function transpileFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = await esbuild.transform(src, {
    target: TARGET,
    legalComments: 'none',
    sourcefile: path.basename(file),
  });
  fs.writeFileSync(file, out.code);
}

function* walkJs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJs(full);
    else if (entry.isFile() && full.endsWith('.js')) yield full;
  }
}

async function main() {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    console.error('usage: transpile-dir.js <dir> [<dir> ...]');
    process.exit(1);
  }
  let count = 0;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const file of walkJs(root)) {
      await transpileFile(file);
      count++;
    }
  }
  console.log('transpile-dir: lowered ' + count + ' JS file(s) to ' + TARGET);
}

main().catch(function (err) { console.error(err); process.exit(1); });
