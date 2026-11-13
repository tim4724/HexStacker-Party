#!/usr/bin/env node
'use strict';

// Replaces the Apple TV screenshots of an App Store version with
// artwork/store/output/appstore (run screenshots.js first), in every language
// of locales.json. The version must still be editable (create it in App Store
// Connect first) and must already have each language.
//
// Uploads one screenshot at a time and waits until Apple has processed it:
// fired in a quick loop, most uploads sat in UPLOAD_COMPLETE for hours with no
// error, while the same files uploaded one by one processed in seconds.
// Usage: node artwork/store/upload-appstore.js <AuthKey_ID.p8> <issuer-id> <version>

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const APP_ID = '6788876779';
const OUT = path.join(__dirname, 'output', 'appstore');
const LOCALES = require('./locales.json');
const PROCESS_TIMEOUT_MS = 180000;

(async () => {
  const [keyFile, issuer, version] = process.argv.slice(2);
  if (!version) throw new Error('usage: upload-appstore.js <AuthKey_ID.p8> <issuer-id> <version>');
  const key = fs.readFileSync(keyFile);
  const kid = path.basename(keyFile).replace(/^AuthKey_|\.p8$/g, '');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  function token() {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: 'ES256', kid, typ: 'JWT' })}.${b64({ iss: issuer, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })}`;
    return `${unsigned}.${crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  }
  async function api(method, p, body) {
    const res = await fetch(`https://api.appstoreconnect.apple.com${p}`, { method, body: body && JSON.stringify(body),
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' } });
    if (res.status === 204) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(json.errors || json)}`);
    return json;
  }

  const ver = (await api('GET', `/v1/apps/${APP_ID}/appStoreVersions?filter[versionString]=${version}&filter[platform]=TV_OS`)).data[0];
  if (!ver) throw new Error(`no tvOS version ${version} in App Store Connect`);
  const locs = (await api('GET', `/v1/appStoreVersions/${ver.id}/appStoreVersionLocalizations?limit=50`)).data;

  for (const { app, asc } of LOCALES) {
    const loc = locs.find((l) => l.attributes.locale === asc);
    if (!loc) throw new Error(`version ${version} has no ${asc} localization`);
    const sets = (await api('GET', `/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets`)).data;
    let set = sets.find((s) => s.attributes.screenshotDisplayType === 'APP_APPLE_TV');
    if (set) {
      for (const old of (await api('GET', `/v1/appScreenshotSets/${set.id}/appScreenshots?limit=50`)).data) {
        await api('DELETE', `/v1/appScreenshots/${old.id}`);
      }
    } else {
      set = (await api('POST', '/v1/appScreenshotSets', { data: { type: 'appScreenshotSets',
        attributes: { screenshotDisplayType: 'APP_APPLE_TV' },
        relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: loc.id } } } } })).data;
    }

    const dir = path.join(OUT, app);
    const ids = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort()) {
      const buf = fs.readFileSync(path.join(dir, file));
      const shot = (await api('POST', '/v1/appScreenshots', { data: { type: 'appScreenshots',
        attributes: { fileName: `${app}-${file}`, fileSize: buf.length },
        relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: set.id } } } } })).data;
      for (const op of shot.attributes.uploadOperations) {
        const res = await fetch(op.url, { method: op.method, body: new Uint8Array(buf.subarray(op.offset, op.offset + op.length)),
          headers: Object.fromEntries((op.requestHeaders || []).map((h) => [h.name, h.value])) });
        if (!res.ok) throw new Error(`upload ${asc}/${file} -> ${res.status}`);
      }
      await api('PATCH', `/v1/appScreenshots/${shot.id}`, { data: { type: 'appScreenshots', id: shot.id,
        attributes: { uploaded: true, sourceFileChecksum: crypto.createHash('md5').update(buf).digest('hex') } } });
      for (const start = Date.now(); ;) {
        await new Promise((r) => setTimeout(r, 3000));
        const state = (await api('GET', `/v1/appScreenshots/${shot.id}`)).data.attributes.assetDeliveryState;
        if (state?.state === 'COMPLETE') break;
        if (state?.state === 'FAILED') throw new Error(`${asc}/${file} failed: ${JSON.stringify(state.errors)}`);
        if (Date.now() - start > PROCESS_TIMEOUT_MS) throw new Error(`${asc}/${file} still ${state?.state}; re-run to retry`);
      }
      ids.push(shot.id);
    }
    await api('PATCH', `/v1/appScreenshotSets/${set.id}/relationships/appScreenshots`,
      { data: ids.map((id) => ({ type: 'appScreenshots', id })) });
    console.log(`${asc}: ${ids.length} screenshots`);
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
