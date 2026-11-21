'use strict';

// =====================================================================
// App offer: a browser player is offered the Paper Balloon Controller
// app before the name field (CONTRACT.md §13 in the launcher repo). This
// file only builds the links; controller.js decides when the offer shows.
// =====================================================================

var AppOffer = {
  PACKAGE: 'games.paperballoon.controller',
  APP_STORE: 'https://apps.apple.com/app/id6825072879',

  // 'ios' | 'android' | null. The iOS app is iPhone-only, so an iPad (and
  // every desktop) gets no offer.
  platform: function (ua) {
    if (/iPhone/.test(ua)) return 'ios';
    if (/Android/.test(ua)) return 'android';
    return null;
  },

  // The link the offer's button opens. On Android it carries joinUrl (what
  // the QR encodes) into the app, which joins it like a scanned link.
  link: function (os, ua, joinUrl) {
    // A Camera scan already opens the App Clip, so an iPhone only lands here
    // another way (another browser, a typed or shared link), where Apple's
    // App Clip link is unreliable. The App Store link works everywhere but
    // carries no room: iOS has no install referrer, so the player scans the
    // code again in the app.
    if (os === 'ios') return AppOffer.APP_STORE;
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
