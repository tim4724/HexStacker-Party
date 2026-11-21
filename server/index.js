'use strict';

// Local dev and e2e server. Deployed hosts serve the static site/ through Apache
// instead (scripts/build-site.js, public/.htaccess); the routes here mirror it.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.PORT, 10) || 4000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Build-time ad-clip composite rig, loaded only by artwork/ad-clip/capture.js
// driving Playwright against this server.
const AD_CLIP_COMPOSITE_DIR = path.join(__dirname, '..', 'artwork', 'ad-clip', 'composite');
// PartyPlug — reusable party-game framework (transport layer), shared across
// games and intentionally outside public/ so it isn't tied to this one app's
// assets. Served under /partyplug/ via the baseDir remap below.
const PARTYPLUG_DIR = path.join(__dirname, '..', 'partyplug');
const APP_VERSION = require('../package.json').version;

// The pages' script and style tags. SERVE_BUNDLES=1 (e2e) serves one hashed
// bundle per app, the concatenated artifact users get, where strict-mode
// flattening and cross-file hoisting live; it needs `npm run build` first.
// Otherwise the individual files in their canonical order, for instant edits.
const { CONTROLLER_SCRIPTS, DISPLAY_SCRIPTS, AC_CONTROLLER_SCRIPTS, AC_DISPLAY_SCRIPTS, CONTROLLER_STYLES, DISPLAY_STYLES } = require('../scripts/asset-manifest.js');
const { renderShell, bundleSubs } = require('../scripts/render-shell.js');

function scriptTags(scripts) {
  return scripts.map(function (s) { return '<script src="' + s + '"></script>'; }).join('\n  ');
}
function styleTags(styles) {
  return styles.map(function (s) { return '<link rel="stylesheet" href="' + s + '">'; }).join('\n  ');
}

const TAGS = process.env.SERVE_BUNDLES === '1'
  ? bundleSubs(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dist', 'web-manifest.json'), 'utf8')))
  : {
    controllerScripts: scriptTags(CONTROLLER_SCRIPTS),
    displayScripts: scriptTags(DISPLAY_SCRIPTS),
    acControllerScripts: scriptTags(AC_CONTROLLER_SCRIPTS),
    acDisplayScripts: scriptTags(AC_DISPLAY_SCRIPTS),
    controllerStyles: styleTags(CONTROLLER_STYLES),
    displayStyles: styleTags(DISPLAY_STYLES),
  };

function renderPage(html) {
  return renderShell(html, Object.assign({ versionLabel: APP_VERSION, appVersion: APP_VERSION }, TAGS));
}

// Allowlist of engine modules serveable via the /engine/ route, derived from the
// canonical script lists so it can't drift from them. A hand-kept copy did: when
// RoomCore.js joined DISPLAY_SCRIPTS it was missing here, and dev mode (individual
// tags) 404'd it while the bundle (which inlines the file) stayed fine.
const ENGINE_FILES = new Set(
  [].concat(CONTROLLER_SCRIPTS, DISPLAY_SCRIPTS, AC_CONTROLLER_SCRIPTS, AC_DISPLAY_SCRIPTS)
    .filter((p) => p.startsWith('/engine/'))
    .map((p) => p.slice('/engine/'.length))
);

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.map': 'application/json'
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  // Serve game engine modules to browser
  if (urlPath.startsWith('/engine/')) {
    const engineFile = urlPath.slice('/engine/'.length);
    if (ENGINE_FILES.has(engineFile)) {
      const enginePath = path.join(__dirname, engineFile);
      fs.readFile(enginePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, {
          'Content-Type': 'text/javascript',
          'Cache-Control': 'no-store'
        });
        res.end(data);
      });
      return;
    }
  }

  // Cross-platform TV gallery (scripts/gallery), so the gallery nav's TV link
  // works in local dev after a local capture/assemble. Deployed hosts never
  // reach this route: Traefik path-routes /gallery-tv to the static gallery pod.
  if (urlPath === '/gallery-tv') {
    // Redirect to the slash form so the page's relative shots/ paths resolve.
    res.writeHead(301, { Location: '/gallery-tv/' });
    res.end();
    return;
  }
  if (urlPath.startsWith('/gallery-tv/')) {
    const rest = urlPath === '/gallery-tv/'
      ? 'gallery.html'
      : urlPath.slice('/gallery-tv/'.length);
    if (rest.includes('..')) { res.writeHead(400); res.end('Bad Request'); return; }
    const tvGalleryPath = path.join(__dirname, '..', 'scripts', 'gallery', rest);
    fs.readFile(tvGalleryPath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found — regenerate via scripts/gallery/README.md');
        return;
      }
      const type = rest.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  // Brand-asset gallery (public/gallery-artwork.html) shows icons/key art that
  // live OUTSIDE public/: the tvOS + Android icon sources and the artwork/ tree.
  // Expose just those three repo dirs, image files only, read-only — allowlisted
  // by top-level dir + extension so source code stays unreachable. urlPath is
  // un-decoded (req.url), and the appletv paths carry %20/%26, so decode first.
  if (urlPath.startsWith('/gallery-assets/')) {
    let rest;
    try { rest = decodeURIComponent(urlPath.slice('/gallery-assets/'.length)); }
    catch (e) { res.writeHead(400); res.end('Bad Request'); return; }
    const repoRoot = path.join(__dirname, '..');
    const assetPath = path.join(repoRoot, rest);
    const allowed =
      !rest.includes('..') &&
      /^(appletv|android|artwork)\//.test(rest) &&
      /\.(png|jpe?g|webp|svg)$/i.test(rest) &&
      assetPath.startsWith(repoRoot + path.sep);
    if (!allowed) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); return; }
    fs.readFile(assetPath, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(assetPath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
    return;
  }

  // App-link statements (public/.well-known/, see the notes in public/.htaccess).
  // Explicit route because the AASA has no extension: the generic static path
  // would send it as octet-stream, and Apple's CDN only accepts application/json.
  if (urlPath === '/.well-known/apple-app-site-association' || urlPath === '/.well-known/assetlinks.json') {
    fs.readFile(path.join(PUBLIC_DIR, urlPath), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    });
    return;
  }

  // Health check endpoint
  if (urlPath === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  // Base URL endpoint — returns the LAN-accessible origin for join URLs/QR codes
  if (urlPath === '/api/baseurl') {
    const baseUrl = process.env.BASE_URL || `http://${getLocalIP()}:${PORT}`;
    sendJson(res, 200, { baseUrl });
    return;
  }


  // AirConsole entry points at root
  if (urlPath === '/screen.html') {
    urlPath = '/display/screen.html';
  } else if (urlPath === '/controller.html') {
    urlPath = '/controller/controller.html';
  }

  // Map directory paths to index.html
  if (urlPath === '/') {
    urlPath = '/display/index.html';
  } else if (urlPath === '/gallery' || urlPath === '/gallery-controller' || urlPath === '/gallery-rotations' || urlPath === '/gallery-artwork') {
    // Extensionless gallery URLs, carved out ahead of the room-code catch
    // below. Deployed hosts never get here:
    // Traefik routes /gallery* to the static gallery pod, whose nginx does the
    // same $uri.html resolution.
    urlPath = urlPath + '.html';
  } else if (urlPath.length > 1 && !urlPath.includes('.') && urlPath.split('/').filter(Boolean).length === 1) {
    // Single path segment with no file extension -> room code -> serve controller
    urlPath = '/controller/index.html';
  }

  let baseDir = PUBLIC_DIR;
  let lookupPath = urlPath;
  if (urlPath.startsWith('/artwork/ad-clip/')) {
    baseDir = AD_CLIP_COMPOSITE_DIR;
    lookupPath = urlPath.slice('/artwork/ad-clip'.length);
  } else if (urlPath.startsWith('/partyplug/')) {
    // Only the runtime modules are browser-facing: a single flat `.js` file.
    // This keeps the kit's dev/package artifacts (tests/, *.d.ts, package.json,
    // README.md) unreachable, mirroring the /engine/ route's restriction.
    if (!/^\/[\w.-]+\.js$/.test(urlPath.slice('/partyplug'.length))) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    baseDir = PARTYPLUG_DIR;
    lookupPath = urlPath.slice('/partyplug'.length);
  }

  const filePath = path.join(baseDir, lookupPath);

  // Prevent directory traversal. The trailing separator is load-bearing:
  // without it, `/public-evil/...` (resolved via `..` segments in lookupPath)
  // would slip past the prefix check against `/public`.
  if (!filePath.startsWith(baseDir + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // MP4: serve via streaming with Range support so the <video> element can
  // seek. fs.readFile + res.end (the path below) sends the whole buffer
  // without an Accept-Ranges header, which disables seeking in the browser
  // controls. Currently only the welcome-screen trailer needs this.
  if (path.extname(filePath).toLowerCase() === '.mp4') {
    fs.stat(filePath, (err, stat) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      const fileSize = stat.size;
      const baseHeaders = {
        'Content-Type': MIME_TYPES['.mp4'],
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      };
      const rangeHeader = req.headers.range;
      if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
        if (!match) {
          res.writeHead(416, Object.assign({}, baseHeaders, { 'Content-Range': 'bytes */' + fileSize }));
          res.end();
          return;
        }
        let start, end;
        if (match[1] === '' && match[2] !== '') {
          // Suffix range: last N bytes
          start = Math.max(0, fileSize - parseInt(match[2], 10));
          end = fileSize - 1;
        } else {
          start = match[1] ? parseInt(match[1], 10) : 0;
          end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
        }
        if (start >= fileSize || end >= fileSize || start > end) {
          res.writeHead(416, Object.assign({}, baseHeaders, { 'Content-Range': 'bytes */' + fileSize }));
          res.end();
          return;
        }
        res.writeHead(206, Object.assign({}, baseHeaders, {
          'Content-Range': 'bytes ' + start + '-' + end + '/' + fileSize,
          'Content-Length': end - start + 1,
        }));
        fs.createReadStream(filePath, { start: start, end: end }).pipe(res);
      } else {
        res.writeHead(200, Object.assign({}, baseHeaders, { 'Content-Length': fileSize }));
        fs.createReadStream(filePath).pipe(res);
      }
    });
    return;
  }

  // Never cached, so an edit shows on the next reload.
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    if (ext === '.html') data = renderPage(data.toString('utf8'));
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// --- Get local network IP ---
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// --- Start server ---
// Guarded so tests can require this module and listen on a port of their own.
if (require.main === module) {
  server.listen(PORT, () => {
    const localIP = getLocalIP();
    console.log(`HexStacker Party server running on http://localhost:${PORT}`);
    console.log(`Local network: http://${localIP}:${PORT}`);
    console.log(`Display: http://localhost:${PORT}/`);
  });
}

module.exports = { server };
