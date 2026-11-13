#!/usr/bin/env node
'use strict';

// Replaces the Google Play screenshots and graphics with artwork/store/output
// (run screenshots.js first): per language the Android TV screenshots and the
// phone screenshots (the same set; Play shows phone screenshots on the web
// listing), and for the default language the feature graphic and TV banner.
// One edit, validated, then committed, which sends the listing for review.
// Usage: node artwork/store/upload-play.js <service-account.json> [--dry-run]
//   --dry-run uploads into the edit and validates it, then discards it.

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PACKAGE = 'com.couchgames.stacker';
const OUT = path.join(__dirname, 'output');
const LOCALES = require('./locales.json');
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const UPLOAD = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}`;

async function accessToken(keyFile) {
  const sa = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const jwt = `${unsigned}.${crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url')}`;
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}` });
  const json = await res.json();
  if (!json.access_token) throw new Error(`token request failed: ${res.status}`);
  return json.access_token;
}

(async () => {
  const [keyFile, flag] = process.argv.slice(2);
  if (!keyFile) throw new Error('usage: upload-play.js <service-account.json> [--dry-run]');
  const token = await accessToken(keyFile);
  async function call(method, url, body) {
    const png = Buffer.isBuffer(body);
    const res = await fetch(url, { method, body: png ? body : body && JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, 'content-type': png ? 'image/png' : 'application/json' } });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`${method} ${url.replace(/.*\/applications\/[^/]+/, '')} -> ${res.status} ${JSON.stringify(json)}`), { json });
    return json;
  }
  const id = (await call('POST', `${API}/edits`)).id;
  const edit = `${API}/edits/${id}`, upload = `${UPLOAD}/edits/${id}`;
  let committed = false;
  try {
    for (const { app, play: lang } of LOCALES) {
      const dir = path.join(OUT, 'play', app);
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
      for (const type of ['tvScreenshots', 'phoneScreenshots']) {
        await call('DELETE', `${edit}/listings/${lang}/${type}`);
        for (const f of files) await call('POST', `${upload}/listings/${lang}/${type}?uploadType=media`, fs.readFileSync(path.join(dir, f)));
      }
      console.log(`${lang}: ${files.length} TV + ${files.length} phone screenshots`);
    }
    const lang = LOCALES[0].play;
    for (const [type, file] of [['featureGraphic', 'play-feature-graphic.png'], ['tvBanner', 'play-tv-banner.png']]) {
      await call('DELETE', `${edit}/listings/${lang}/${type}`);
      await call('POST', `${upload}/listings/${lang}/${type}?uploadType=media`, fs.readFileSync(path.join(OUT, file)));
    }
    console.log(`${lang}: feature graphic + TV banner`);
    await call('POST', `${edit}:validate`);
    if (flag === '--dry-run') return console.log('valid; dry run, discarding the edit');
    try {
      await call('POST', `${edit}:commit`);
      console.log('committed and sent for review');
    } catch (err) {
      // Apps with managed publishing refuse an auto-sent commit; hand the review to the console.
      if (!/changesNotSentForReview/.test(JSON.stringify(err.json))) throw err;
      await call('POST', `${edit}:commit?changesNotSentForReview=true`);
      console.log('committed; send the changes for review in Play Console');
    }
    committed = true;
  } finally {
    if (!committed) await call('DELETE', edit).catch(() => {});
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
