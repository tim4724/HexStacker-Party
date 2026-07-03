'use strict';

// Brand-asset gallery: tag any card whose image failed to load — git-ignored
// preview folders before their generator has run, or the tvOS/Android source
// dirs the prod image doesn't ship — so it shows a hint instead of a broken
// glyph. Lives in its own file (not inline) because the page is served with
// `script-src 'self'`, which blocks inline scripts. Also handles the cached-404
// case where the error event already fired before this listener attached.
(function () {
  function markMissing(img) {
    var fig = img.closest('figure');
    if (fig) fig.classList.add('missing');
  }
  var imgs = document.querySelectorAll('figure img');
  for (var i = 0; i < imgs.length; i++) {
    var img = imgs[i];
    img.addEventListener('error', function () { markMissing(this); });
    if (img.complete && img.naturalWidth === 0) markMissing(img);
  }
})();
