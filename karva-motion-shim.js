/* Showcase motion shim (added for client presentation).
   - Plays motion even when the OS asks for reduced motion, unless the shared
     Karva Motion switch is set to "off" (localStorage karva-motion).
   - ?motion=on / ?motion=off in the URL sets that switch.
   - Clears the "intro already seen" flags so opening intros replay on every load. */
(function () {
  var KEY = 'karva-motion', v = null;
  try {
    var q = /[?&]motion=(on|off)\b/.exec(location.search);
    if (q) localStorage.setItem(KEY, q[1]);
    v = localStorage.getItem(KEY);
  } catch (e) {}
  try { ['karva-spice-arrival-seen', 'karva-entrance-seen'].forEach(function (k) { sessionStorage.removeItem(k); }); } catch (e) {}
  if (v === 'off' || !window.matchMedia) return;
  var RE = /prefers-reduced-motion\s*:\s*reduce/i, NP = /prefers-reduced-motion\s*:\s*no-preference/i;
  var mm = window.matchMedia.bind(window);
  window.matchMedia = function (query) {
    if (RE.test(query)) return mm('not all');
    if (NP.test(query)) return mm('all');
    return mm(query);
  };
  function walk(rules) {
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.media && r.media.mediaText) {
        if (RE.test(r.media.mediaText)) r.media.mediaText = 'not all';
        else if (NP.test(r.media.mediaText)) r.media.mediaText = 'all';
      }
      if (r.cssRules) walk(r.cssRules);
    }
  }
  function fix() {
    for (var i = 0; i < document.styleSheets.length; i++) {
      var rules; try { rules = document.styleSheets[i].cssRules; } catch (e) { continue; }
      if (rules) walk(rules);
    }
  }
  fix();
  document.addEventListener('DOMContentLoaded', fix);
  window.addEventListener('load', fix);
  try { new MutationObserver(fix).observe(document.head || document.documentElement, { childList: true }); } catch (e) {}
})();
