'use strict';

// Android TV <-> web i18n lockstep guard.
//
// The TV's res/values*/strings.xml are hand-copied from public/shared/i18n.js
// (the source of truth; see values/strings.xml's own header). Nothing links them
// mechanically, so a copy tweak or a new locale on the web would drift silently.
// This test re-derives every translatable Android string from LOCALES and fails
// on any mismatch — the same role tests/room-snapshot.test.js's lockstep guard
// plays for hand-mirrored code fragments.
//
// Deliberately NOT codegen: strings.xml stays a reviewable source file (and
// Android Studio builds keep working without Node); this gate just makes the
// mirror impossible to break unnoticed.
//
// Also gates the byte-identity of the music asset (res/raw <- public/shared).
// The Orbitron font is NOT gated: the web ships .woff2, Android needs .ttf —
// same typeface, different container, no byte comparison possible.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { LOCALES } = require('../public/shared/i18n.js');

const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'android', 'tv', 'src', 'main', 'res');

// Android resource name -> i18n.js key, where the names differ.
const KEY_MAP = {
  double_clear: 'double',
  triple_clear: 'triple',
};

// TV-only strings with no web counterpart, so there is no i18n.js key to mirror:
// the web app ships no Open Source Licenses page (it bundles almost no third-party
// code), while the TV apps must attribute their bundled deps. English-only until
// translated; excluded from the lockstep guard (they carry tools:ignore in the XML).
const TV_ONLY = new Set(['licenses_title', 'licenses_back_hint']);

// Web {placeholder} templates -> the Android positional arg used in strings.xml.
// Single-arg strings use %1$d/%1$s; attempt_n_of_m is the one two-arg string
// ({attempt} first, {max} second).
function normalizeWebValue(v) {
  return v
    .replace(/\{(count|n|level|attempt)\}/g, '%1$d')
    .replace(/\{max\}/g, '%2$d')
    .replace(/\{name\}/g, '%1$s');
}

function unescapeAndroid(v) {
  return v
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Minimal parser for this repo's strings.xml shape (flat <string>/<plurals>).
function parseStringsXml(file) {
  const xml = fs.readFileSync(file, 'utf8');
  const strings = new Map();
  const plurals = new Map();
  const stringRe = /<string\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/string>/g;
  for (const m of xml.matchAll(stringRe)) {
    if (m[2].includes('translatable="false"')) continue;
    strings.set(m[1], unescapeAndroid(m[3]));
  }
  const pluralsRe = /<plurals\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/plurals>/g;
  const itemRe = /<item\s+quantity="([^"]+)"\s*>([\s\S]*?)<\/item>/g;
  for (const m of xml.matchAll(pluralsRe)) {
    const items = new Map();
    for (const im of m[2].matchAll(itemRe)) items.set(im[1], unescapeAndroid(im[2]));
    plurals.set(m[1], items);
  }
  return { strings, plurals };
}

// values -> en, values-de -> de, ... Only dirs that carry a strings.xml.
function localeDirs() {
  return fs
    .readdirSync(RES)
    .filter((d) => d === 'values' || /^values-[a-z]{2}$/.test(d))
    .filter((d) => fs.existsSync(path.join(RES, d, 'strings.xml')))
    .map((d) => ({ dir: d, locale: d === 'values' ? 'en' : d.slice('values-'.length) }));
}

// The web's t() falls back to en for keys a locale omits; the Android files bake
// that fallback in, so expected = locale value ?? en value.
function webValue(locale, key) {
  const loc = LOCALES[locale] || {};
  return loc[key] !== undefined ? loc[key] : LOCALES.en[key];
}

test('every Android TV locale file mirrors public/shared/i18n.js', () => {
  const dirs = localeDirs();
  assert.ok(dirs.length >= 11, `expected the default + 10 locale dirs, found ${dirs.length}`);

  const problems = [];
  for (const { dir, locale } of dirs) {
    assert.ok(LOCALES[locale] || locale === 'en', `${dir}: no LOCALES['${locale}'] on the web`);
    const { strings, plurals } = parseStringsXml(path.join(RES, dir, 'strings.xml'));

    for (const [name, androidValue] of strings) {
      if (TV_ONLY.has(name)) continue;
      const key = KEY_MAP[name] || name;
      const web = webValue(locale, key);
      if (web === undefined) {
        problems.push(`${dir}/${name}: no i18n.js key '${key}' (update KEY_MAP or i18n.js)`);
        continue;
      }
      if (typeof web !== 'string') {
        problems.push(`${dir}/${name}: i18n.js '${key}' is a plural object but Android uses <string>`);
        continue;
      }
      const expected = normalizeWebValue(web);
      if (androidValue !== expected) {
        problems.push(`${dir}/${name}: '${androidValue}' != web '${expected}'`);
      }
    }

    for (const [name, items] of plurals) {
      const key = KEY_MAP[name] || name;
      const web = webValue(locale, key);
      if (typeof web !== 'object' || web === null) {
        problems.push(`${dir}/${name}: i18n.js '${key}' is not a plural object`);
        continue;
      }
      for (const [quantity, androidValue] of items) {
        // The web plural table may omit a CLDR category the locale doesn't
        // distinguish; Android files only carry categories the web has.
        const webForm = web[quantity] !== undefined ? web[quantity] : web.other;
        if (webForm === undefined) {
          problems.push(`${dir}/${name}[${quantity}]: no web plural form`);
          continue;
        }
        const expected = normalizeWebValue(webForm);
        if (androidValue !== expected) {
          problems.push(`${dir}/${name}[${quantity}]: '${androidValue}' != web '${expected}'`);
        }
      }
    }
  }

  assert.deepStrictEqual(problems, [], `Android strings drifted from i18n.js:\n${problems.join('\n')}`);
});

test('Android music asset is byte-identical to the web track', () => {
  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const webTrack = path.join(ROOT, 'public', 'shared', 'music', 'lunar-joyride.mp3');
  const tvTrack = path.join(ROOT, 'android', 'tv', 'src', 'main', 'res', 'raw', 'lunar_joyride.mp3');
  assert.strictEqual(sha(tvTrack), sha(webTrack), 'res/raw/lunar_joyride.mp3 drifted from public/shared/music/lunar-joyride.mp3');
});
