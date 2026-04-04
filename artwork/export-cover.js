#!/usr/bin/env node
'use strict';

// Headless cover art export — opens the builder, clicks Export, saves the download.
// Requires the server running on port 4000.
// Usage: node banner/export-cover.js [output-path]
// Default: artwork/cover-art.png

const { chromium } = require('playwright');
const path = require('path');

const output = path.resolve(process.argv[2] || 'artwork/cover-art.png');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.goto('http://localhost:4000/artwork/builder.html');
  await page.waitForTimeout(1500); // fonts + render

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportBtn'),
  ]);
  await download.saveAs(output);
  console.log('Exported:', output);
  await browser.close();
})();
