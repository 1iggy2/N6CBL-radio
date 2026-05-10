(function () {
  var qsoLogRequest = null;

  function loadQsoLog() {
    if (!qsoLogRequest) {
      qsoLogRequest = fetch('/data/qso-log.json')
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        });
    }
    return qsoLogRequest;
  }

  function firstActivationSession(data) {
    var sessions = (data && data.sessions) || [];
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].type === 'pota') return sessions[i];
    }
    return sessions[0] || null;
  }

  function primaryBand(session, data) {
    if (session && session.bands && session.bands.length) {
      return String(session.bands[0]).toUpperCase();
    }

    var qsos = (data && data.qsos) || [];
    for (var i = 0; i < qsos.length; i++) {
      if (qsos[i].session === session.id && qsos[i].band) {
        return String(qsos[i].band).toUpperCase();
      }
    }

    return '';
  }

  function formatLastActivation(data) {
    var session = firstActivationSession(data);
    if (!session) return 'LAST ACTIVATION —';

    var parts = ['LAST ACTIVATION'];
    var band = primaryBand(session, data);
    if (session.reference) parts.push(session.reference);
    if (band) parts.push(band);
    parts.push((session.qso_count || 0) + ' QSOs');
    if (session.date) parts.push(session.date);
    return parts.join(' · ');
  }

  function renderLastActivation(data) {
    var el = document.getElementById('header-stat');
    if (!el) return;
    el.textContent = formatLastActivation(data);
  }

  function initChrome() {
    if (!document.getElementById('header-stat')) return;
    loadQsoLog()
      .then(renderLastActivation)
      .catch(function () {
        /* Keep the static fallback text in the header if log data is unavailable. */
      });
  }

  window.N6CBLChrome = {
    loadQsoLog: loadQsoLog,
    renderLastActivation: renderLastActivation,
    formatLastActivation: formatLastActivation
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChrome);
  } else {
    initChrome();
  }
}());
