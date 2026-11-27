#!/usr/bin/env node
'use strict';

// Readies the App Store release a version tag built, up to the point of submitting
// it: waits for the TestFlight build to process, sets up that tvOS version (renaming
// one still being prepared, as for a superseded tag, else creating it: its listing
// copies over from the live version) and attaches the build. Submitting for review
// stays a separate, deliberate step in App Store Connect.
//
// What's New is not written: store texts live in App Store Connect (see
// artwork/store/README.md), so the languages still missing it are listed instead.
//
// Called by release.yml's appstore job with the tag and the run number the archive
// was stamped with. The Controller's store/appclip/prepare_release.py is the same
// flow for iOS.
// Usage: node appletv/scripts/prepare-release.js <AuthKey_ID.p8> <issuer-id> <version> <build>
// DRY_RUN=1 only reads, printing the writes it would make.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const APP_ID = '6788876779';
const EDITABLE = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED']);
const PROCESSING_TIMEOUT_MS = 45 * 60_000;

(async () => {
  const [keyFile, issuer, version, build] = process.argv.slice(2);
  if (!build) throw new Error('usage: prepare-release.js <AuthKey_ID.p8> <issuer-id> <version> <build>');
  const key = fs.readFileSync(keyFile);
  const kid = path.basename(keyFile).replace(/^AuthKey_|\.p8$/g, '');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  // A fresh token per request: the wait for processing outlasts one.
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
  async function write(method, p, body) {
    if (!process.env.DRY_RUN) return api(method, p, body);
    console.log('would', method, p, JSON.stringify(body).slice(0, 300));
    return { data: { id: 'DRY_RUN' } };
  }

  // Just uploaded, the build takes a while to process.
  let buildId;
  for (const deadline = Date.now() + PROCESSING_TIMEOUT_MS; ;) {
    const found = (await api('GET', `/v1/builds?filter[app]=${APP_ID}&filter[version]=${build}`
      + `&filter[preReleaseVersion.version]=${version}`)).data[0];
    const state = found?.attributes.processingState ?? 'NOT_FOUND';
    console.log('build', version, build, state);
    if (state === 'VALID') { buildId = found.id; break; }
    if (state === 'FAILED' || state === 'INVALID' || Date.now() > deadline) throw new Error(`build not usable: ${state}`);
    await new Promise((r) => setTimeout(r, 60_000));
  }

  const versions = (await api('GET', `/v1/apps/${APP_ID}/appStoreVersions?filter[platform]=TV_OS&limit=50`)).data;
  const editable = versions.find((v) => EDITABLE.has(v.attributes.appStoreState));
  let versionId;
  if (editable) {
    versionId = editable.id;
    console.log('renaming', editable.attributes.versionString, '->', version);
    await write('PATCH', `/v1/appStoreVersions/${versionId}`, { data: { type: 'appStoreVersions', id: versionId,
      attributes: { versionString: version } } });
  } else {
    console.log('creating', version);
    versionId = (await write('POST', '/v1/appStoreVersions', { data: { type: 'appStoreVersions',
      attributes: { platform: 'TV_OS', versionString: version },
      relationships: { app: { data: { type: 'apps', id: APP_ID } } } } })).data.id;
  }
  await write('PATCH', `/v1/appStoreVersions/${versionId}/relationships/build`, { data: { type: 'builds', id: buildId } });

  const missing = versionId === 'DRY_RUN' ? []
    : (await api('GET', `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=50`)).data
      .filter((l) => !l.attributes.whatsNew?.trim()).map((l) => l.attributes.locale);
  console.log(missing.length
    ? `${version} (build ${build}) is set up; write What's New in App Store Connect before submitting: ${missing.join(', ')}`
    : `ready to submit: ${version} (build ${build})`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
