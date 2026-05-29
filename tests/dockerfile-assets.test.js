'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// The server serves these top-level directories at runtime (see server/index.js:
// PUBLIC_DIR, the /engine/ route reading from server/, and PARTYPLUG_DIR). The
// Docker image must COPY each of them or the deployed app 404s those assets
// while every source-tree test still passes — exactly the failure mode that
// shipped /partyplug/* 404s to the preview (RoomFlow undefined -> dead UI).
//
// This guards that class of "works from source, broken in the image" bug. The
// unit + e2e suites run from the working tree, so they can't see a missing
// Dockerfile COPY; this can.
const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');

test('Dockerfile copies every runtime asset directory the server serves', () => {
  for (const dir of ['server/', 'public/', 'partyplug/']) {
    assert.ok(
      new RegExp('COPY\\s+' + dir.replace('/', '\\/')).test(dockerfile),
      `Dockerfile must "COPY ${dir}" or the deployed image 404s those assets`
    );
  }
});
