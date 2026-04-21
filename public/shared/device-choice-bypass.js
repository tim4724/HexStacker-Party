'use strict';

// When redirected here from a controller's "Continue on this device"
// action (`?continue=1`), mark the overlay dismissed before the body
// parses so it never flashes. Runs as a blocking <head> script.
//
// Sets the class on <html> because <body> doesn't exist yet. Seeds
// `dcDismissed` on the landing entry so popstate back doesn't resurface
// the overlay — the user arrived here explicitly dismissing it.
(function () {
  var params = new URLSearchParams(location.search);
  if (params.get('continue') !== '1') return;
  document.documentElement.classList.add('device-choice-dismissed');
  params.delete('continue');
  var qs = params.toString();
  history.replaceState({ dcDismissed: true }, '', location.pathname + (qs ? '?' + qs : ''));
}());
