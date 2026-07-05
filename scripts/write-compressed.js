'use strict';

const fs = require('fs');
const zlib = require('zlib');

// Write `buf` to filePath plus its `.br`/`.gz` siblings at max quality. Used for
// build-time artifacts that server/index.js serves via Accept-Encoding
// negotiation (hashed CSS bundles, pre-rendered HTML). Max effort (brotli 11 /
// gzip 9) is affordable because it's a one-shot on immutable-or-per-deploy bytes;
// only the primary file is written, callers pass the exact bytes to serve.
function writeCompressed(filePath, buf) {
  fs.writeFileSync(filePath, buf);
  fs.writeFileSync(filePath + '.br', zlib.brotliCompressSync(buf, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  }));
  fs.writeFileSync(filePath + '.gz', zlib.gzipSync(buf, { level: 9 }));
}

module.exports = { writeCompressed: writeCompressed };
