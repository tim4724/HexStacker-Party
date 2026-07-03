'use strict';

// Single source for the gallery page navigation (Display / Phone / Rotations /
// TV), shared by all gallery pages. Browser: self-renders into
// <nav data-gallery-nav> and highlights the entry matching the current path.
// Node: scripts/gallery/gen-gallery.mjs requires PAGES to emit the same nav
// statically in the generated TV comparison page.
(function(exports) {

var PAGES = [
  { href: '/gallery', label: 'Display' },
  { href: '/gallery-controller', label: 'Phone' },
  { href: '/gallery-rotations', label: 'Rotations' },
  { href: '/gallery-artwork', label: 'Artwork' },
  { href: '/tv-gallery/', label: 'TV' }
];

exports.PAGES = PAGES;

// Normalize a path for active-matching: legacy .html URLs and trailing
// slashes highlight the same entry as their clean form.
function normalize(p) {
  return p.replace(/\.html$/, '').replace(/\/$/, '') || '/';
}
exports.normalize = normalize;

if (typeof document !== 'undefined') {
  var render = function() {
    var nav = document.querySelector('nav[data-gallery-nav]');
    if (!nav) return;
    for (var i = 0; i < PAGES.length; i++) {
      var a = document.createElement('a');
      a.href = PAGES[i].href;
      a.textContent = PAGES[i].label;
      if (normalize(window.location.pathname) === normalize(PAGES[i].href)) a.className = 'active';
      nav.appendChild(a);
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
}

})(typeof module !== 'undefined' ? module.exports : (window.GalleryNav = {}));
