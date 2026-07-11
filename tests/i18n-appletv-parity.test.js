'use strict';

// Apple TV <-> web i18n lockstep guard.
//
// The tvOS app localizes the platform-default way: a committed string catalog
// (appletv/Sources/HexStackerTV/Localizable.xcstrings) that Xcode compiles to
// per-locale .strings/.stringsdict, resolved through Foundation. The catalog is
// a mirror of public/shared/i18n.js (the source of truth); nothing links them
// mechanically, so this test re-derives every entry from LOCALES and fails on
// any mismatch — the tvOS twin of tests/i18n-android-parity.test.js.
//
// Deliberately NOT codegen: the catalog stays a reviewable source file (and
// Xcode builds keep working without Node); this gate just makes the mirror
// impossible to break unnoticed.
//
// Unlike Android (where aapt compile-checks R.string usage), tvOS resolves
// keys at runtime, so this test also greps the Swift call sites and requires
// the catalog to cover exactly the keys the code renders — a stale entry or a
// tr() call with no catalog entry both fail.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { LOCALES } = require('../public/shared/i18n.js');

const ROOT = path.join(__dirname, '..');
const CATALOG = path.join(ROOT, 'appletv', 'Sources', 'HexStackerTV', 'Localizable.xcstrings');
const SWIFT_DIR = path.join(ROOT, 'appletv', 'Sources');

// Web {placeholder} templates -> the positional printf specifier used in the
// catalog (same convention as the Android strings.xml mirror): single-arg
// strings use %1$d; attempt_n_of_m is the one two-arg string ({attempt} first,
// {max} second).
function normalizeWebValue(v) {
  return v
    .replace(/\{(count|level|attempt)\}/g, '%1$d')
    .replace(/\{max\}/g, '%2$d');
}

// The web's t() falls back to en for keys a locale omits; the catalog does the
// same through Foundation's bundle fallback, so a locale entry must exist iff
// the web locale carries the key.
function webValue(locale, key) {
  return (LOCALES[locale] || {})[key];
}

function swiftKeys() {
  const keys = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.swift')) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/\btr(?:Upper)?\(\s*"([^"]+)"/g)) keys.add(m[1]);
      }
    }
  };
  walk(SWIFT_DIR);
  return keys;
}

test('Localizable.xcstrings mirrors public/shared/i18n.js', () => {
  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  assert.strictEqual(catalog.sourceLanguage, 'en');

  const problems = [];
  for (const [key, entry] of Object.entries(catalog.strings)) {
    const locs = entry.localizations || {};
    // Two-way locale coverage: every web locale that carries the key must be in
    // the catalog (a new locale in i18n.js fails here until mirrored), and the
    // catalog must not carry locales the web lacks.
    for (const locale of Object.keys(LOCALES)) {
      if (webValue(locale, key) !== undefined && !locs[locale]) {
        problems.push(`${key}: missing locale '${locale}' (present in i18n.js)`);
      }
    }

    for (const [locale, loc] of Object.entries(locs)) {
      const web = webValue(locale, key);
      if (web === undefined) {
        problems.push(`${key}/${locale}: no i18n.js counterpart`);
        continue;
      }
      if (loc.stringUnit) {
        if (typeof web !== 'string') {
          problems.push(`${key}/${locale}: catalog is plain but i18n.js is a plural object`);
        } else if (loc.stringUnit.value !== normalizeWebValue(web)) {
          problems.push(`${key}/${locale}: '${loc.stringUnit.value}' != web '${normalizeWebValue(web)}'`);
        }
        continue;
      }
      const plural = loc.variations && loc.variations.plural;
      if (!plural) {
        problems.push(`${key}/${locale}: neither stringUnit nor plural variations`);
        continue;
      }
      if (typeof web !== 'object' || web === null) {
        problems.push(`${key}/${locale}: catalog is plural but i18n.js is a plain string`);
        continue;
      }
      const webCats = Object.keys(web).sort();
      const catCats = Object.keys(plural).sort();
      assert.deepStrictEqual(catCats, webCats,
        `${key}/${locale}: plural categories ${catCats} != web ${webCats}`);
      for (const [cat, u] of Object.entries(plural)) {
        const expected = normalizeWebValue(web[cat]);
        if (u.stringUnit.value !== expected) {
          problems.push(`${key}/${locale}[${cat}]: '${u.stringUnit.value}' != web '${expected}'`);
        }
      }
    }
  }

  assert.deepStrictEqual(problems, [], `tvOS catalog drifted from i18n.js:\n${problems.join('\n')}`);
});

test('catalog covers exactly the keys the Swift display renders', () => {
  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const catalogKeys = Object.keys(catalog.strings).sort();
  const usedKeys = [...swiftKeys()].sort();
  assert.ok(usedKeys.length >= 25, `suspiciously few tr() call sites found (${usedKeys.length}) — extraction regex broken?`);
  assert.deepStrictEqual(catalogKeys, usedKeys,
    'Localizable.xcstrings keys != tr()/trUpper() keys in appletv/Sources');
});
