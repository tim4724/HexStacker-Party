'use strict';

// Legal HTML <-> web i18n lockstep guard.
//
// public/privacy.html and public/imprint.html carry a baked-in German copy of the
// legal text: every `data-i18n` / `data-i18n-title` element holds the German string
// as its content, which is what the page shows before JS runs and what no-JS clients
// and crawlers see. At runtime the shared i18n swaps in the visitor's locale from
// public/shared/i18n.js. Nothing links the baked-in copy to i18n.js, so a wording
// change in one drifts from the other silently (exactly how the TV-app privacy
// coverage first landed in i18n.js but not the HTML).
//
// This test re-derives every data-i18n element's expected text from LOCALES.de (with
// an en fallback, mirroring the runtime t()) and fails on any mismatch. It is the
// same lockstep role tests/i18n-android-parity.test.js plays for the Android
// strings.xml mirror.
//
// Deliberately NOT codegen: the HTML stays a reviewable, hand-edited source file;
// this gate just makes the mirror impossible to break unnoticed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { LOCALES } = require('../public/shared/i18n.js');

const ROOT = path.join(__dirname, '..');
const FILES = ['privacy.html', 'imprint.html'];
// Both pages are <html lang="de"> with German baked in.
const BAKED_LOCALE = 'de';

// Decode the HTML entities these pages actually use (privacy.html uses &shy;; the
// rest guard against future edits).
function decodeEntities(s) {
  return s
    .replace(/&shy;/g, '­')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&'); // last: don't double-decode
}

// The web t() falls back to en for keys a locale omits; the baked-in copy follows
// the same rule, so expected = de value ?? en value.
function expectedText(key) {
  const de = LOCALES[BAKED_LOCALE] || {};
  return de[key] !== undefined ? de[key] : LOCALES.en[key];
}

// Every data-i18n / data-i18n-title element as { key, text }. The legal pages never
// nest one data-i18n element inside another, so a non-greedy match to the next
// matching close tag captures the full inner text.
function extractI18n(html) {
  const out = [];
  for (const m of html.matchAll(/<(\w+)[^>]*\bdata-i18n-title="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)) {
    out.push({ key: m[2], text: m[3], attr: 'data-i18n-title' });
  }
  for (const m of html.matchAll(/<(\w+)[^>]*\bdata-i18n="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)) {
    out.push({ key: m[2], text: m[3], attr: 'data-i18n' });
  }
  return out;
}

test('legal HTML baked-in text mirrors public/shared/i18n.js', () => {
  const problems = [];
  for (const file of FILES) {
    const html = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
    const items = extractI18n(html);
    assert.ok(items.length > 0, `${file}: no data-i18n elements found (parser broke?)`);
    for (const { key, text, attr } of items) {
      const expected = expectedText(key);
      if (expected === undefined) {
        problems.push(`${file} [${attr}="${key}"]: no i18n.js key '${key}'`);
        continue;
      }
      const actual = decodeEntities(text);
      if (actual !== expected) {
        problems.push(`${file} [${key}]: baked '${actual}' != i18n.js ${BAKED_LOCALE} '${expected}'`);
      }
    }
  }
  assert.deepStrictEqual(problems, [], `Legal HTML drifted from i18n.js:\n${problems.join('\n')}`);
});
