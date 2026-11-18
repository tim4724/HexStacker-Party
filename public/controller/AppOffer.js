'use strict';

// =====================================================================
// App offer: a browser player is offered the Paper Balloon Controller
// app before the name field (CONTRACT.md §13 in the launcher repo). This
// file only builds the links; controller.js decides when the offer shows.
// =====================================================================

var AppOffer = {
  PACKAGE: 'games.paperballoon.controller',
  CLIP: 'games.paperballoon.controller.Clip',

  // 'ios' | 'android' | null. The App Clip is iPhone-only, so an iPad (and
  // every desktop) gets no offer.
  platform: function (ua) {
    if (/iPhone/.test(ua)) return 'ios';
    if (/Android/.test(ua)) return 'android';
    return null;
  },

  // The link the offer's button opens. It carries joinUrl (what the QR
  // encodes) into the app, which joins it like a scanned link.
  link: function (os, ua, joinUrl) {
    if (os === 'ios') {
      // Apple's default App Clip link: Safari shows the clip card, and the
      // launcher unwraps `url` from the invocation URL.
      return 'https://appclip.apple.com/id?p=' + AppOffer.CLIP + '&url=' + encodeURIComponent(joinUrl);
    }
    var play = 'https://play.google.com/store/apps/details?id=' + AppOffer.PACKAGE
      + '&referrer=' + encodeURIComponent(joinUrl);
    // Chromium browsers open an installed app straight on the room through
    // an intent link and fall back to Play. Firefox and in-app WebViews get
    // the plain Play link, which still carries the room through an install.
    if (!/Chrome\//.test(ua) || /; wv\)|FBA[NV]|Instagram/.test(ua)) return play;
    // Android splits an intent URL at its LAST '#', so the join URL's own
    // #instance fragment survives in front of #Intent.
    var scheme = joinUrl.slice(0, joinUrl.indexOf(':'));
    return 'intent:' + joinUrl.slice(scheme.length + 1)
      + '#Intent;scheme=' + scheme + ';package=' + AppOffer.PACKAGE
      + ';S.browser_fallback_url=' + encodeURIComponent(play) + ';end';
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AppOffer;
}
