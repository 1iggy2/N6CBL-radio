/* UAV Lab X shell — tab navigation for narrow viewports.
   All functionality lives in the shared engine (/tools/uav/uav.js);
   this file only drives the experimental interface chrome. */
(function () {
  'use strict';

  var tabs = Array.prototype.slice.call(document.querySelectorAll('.xtab'));
  var views = Array.prototype.slice.call(document.querySelectorAll('.xview'));

  function activate(name) {
    tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
    views.forEach(function (v) { v.classList.toggle('active', v.dataset.view === name); });
    try { sessionStorage.setItem('uavx.tab', name); } catch (e) { /* private mode */ }
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      activate(t.dataset.tab);
      window.scrollTo({ top: 0 });
    });
  });

  var initial = 'mission';
  try { initial = sessionStorage.getItem('uavx.tab') || initial; } catch (e) { /* ignore */ }
  activate(initial);

  // the mission solver and searches write their results into the Optimize
  // view — on a phone, surface that with a one-time attention dot on the tab
  var optimizeTab = tabs.filter(function (t) { return t.dataset.tab === 'optimize'; })[0];
  var bestHost = document.getElementById('uav-mc-best');
  if (optimizeTab && bestHost && 'MutationObserver' in window) {
    new MutationObserver(function () {
      if (bestHost.childElementCount && !optimizeTab.classList.contains('active')) {
        optimizeTab.classList.add('xtab-dot');
      } else {
        optimizeTab.classList.remove('xtab-dot');
      }
    }).observe(bestHost, { childList: true });
    optimizeTab.addEventListener('click', function () { optimizeTab.classList.remove('xtab-dot'); });
  }
}());
