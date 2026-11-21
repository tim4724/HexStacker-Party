'use strict';

const fs = require('fs');
const zlib = require('zlib');
const { promisify } = require('util');

const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

// Write `buf` to filePath plus its `.br`/`.gz` siblings. Used for the
// content-hashed JS/CSS bundles that server/index.js serves via Accept-Encoding
// negotiation; only the primary file is written, callers pass the exact bytes to
// serve. Async (not the *Sync variants) so the two codecs run on the libuv
// threadpool and, more importantly, so concurrent callers actually overlap —
// build.js builds six artifacts under one Promise.all, which the old sync
// compression serialized back into one core.
async function writeCompressed(filePath, buf) {
  const [br, gz] = await Promise.all([
    brotliCompress(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    }),
    gzip(buf, { level: 9 }),
  ]);
  fs.writeFileSync(filePath, buf);
  fs.writeFileSync(filePath + '.br', br);
  fs.writeFileSync(filePath + '.gz', gz);
}

module.exports = { writeCompressed: writeCompressed };
