/* /tools/night-desk/ — night-ops console engine.
   Vanilla JS, no external scripts. Audio, globe, keyer, and log all run here. */
(function () {
  'use strict';

  var DEG = Math.PI / 180;
  var EARTH_KM = 6371;
  var QTH = {
    call: 'N6CBL',
    grid: 'DM03tu',
    city: 'Hermosa Beach',
    lat: 33.854,
    lon: -118.375
  };

  var BANDS = [
    { id: '80m', label: '80 m', lo: 3500, hi: 4000, center: 3725, hopKm: 1400, nvis: true },
    { id: '40m', label: '40 m', lo: 7000, hi: 7300, center: 7125, hopKm: 2500, nvis: false },
    { id: '20m', label: '20 m', lo: 14000, hi: 14350, center: 14175, hopKm: 3800, nvis: false },
    { id: '15m', label: '15 m', lo: 21000, hi: 21450, center: 21225, hopKm: 4000, nvis: false },
    { id: '10m', label: '10 m', lo: 28000, hi: 29700, center: 28400, hopKm: 4000, nvis: false },
    { id: '6m', label: '6 m', lo: 50000, hi: 54000, center: 50125, hopKm: 2200, nvis: false }
  ];

  var LAND = [
    [[-168,65],[-141,70],[-128,71],[-105,73],[-88,74],[-80,62],[-70,58],[-56,51],[-55,47],[-67,44],[-70,41],[-76,35],[-81,25],[-97,16],[-106,22],[-111,24],[-117,32],[-125,40],[-124,48],[-130,55],[-153,58],[-166,64]],
    [[-73,78],[-60,82],[-22,81],[-20,70],[-44,60],[-58,61],[-70,70]],
    [[-81,12],[-68,12],[-60,8],[-50,0],[-35,-5],[-35,-20],[-40,-32],[-62,-55],[-75,-50],[-74,-18],[-81,-5]],
    [[-10,36],[-9,43],[-5,48],[-5,58],[8,63],[16,69],[30,70],[30,60],[28,45],[20,40],[10,38],[3,43],[-2,43]],
    [[-10,51],[-6,55],[-1,58],[1,52],[-5,50],[-10,51.4]],
    [[-17,15],[-5,36],[10,37],[25,32],[32,31],[43,12],[51,12],[40,-3],[40,-15],[32,-30],[20,-35],[18,-34],[12,-6],[9,4],[-5,5],[-15,10]],
    [[43,-12],[50,-13],[47,-25],[43,-25]],
    [[28,41],[36,36],[44,40],[48,30],[56,27],[62,25],[68,23],[73,22],[77,8],[80,6],[99,6],[109,14],[109,22],[122,30],[122,40],[130,43],[135,45],[142,53],[160,60],[180,66],[170,70],[140,72],[100,76],[80,72],[60,70],[44,68],[40,60],[40,48]],
    [[68,23],[72,21],[77,8],[80,15],[88,22],[80,26],[70,28]],
    [[95,6],[104,2],[118,-4],[130,-8],[140,-8],[150,-2],[131,0],[120,5],[105,12]],
    [[130,32],[131,34],[136,35],[141,39],[145,43],[142,45],[140,41],[135,34]],
    [[114,-22],[114,-34],[136,-35],[153,-28],[153,-12],[142,-11],[136,-14],[128,-14],[122,-18]],
    [[166,-41],[174,-35],[178,-37],[175,-41],[168,-47],[166,-46]],
    [[-180,-72],[-90,-68],[0,-70],[90,-72],[180,-75],[180,-90],[-180,-90]]
  ];

  var MORSE = {
    A:'.-', B:'-...', C:'-.-.', D:'-..', E:'.', F:'..-.', G:'--.', H:'....',
    I:'..', J:'.---', K:'-.-', L:'.-..', M:'--', N:'-.', O:'---', P:'.--.',
    Q:'--.-', R:'.-.', S:'...', T:'-', U:'..-', V:'...-', W:'.--', X:'-..-',
    Y:'-.--', Z:'--..',
    '0':'-----', '1':'.----', '2':'..---', '3':'...--', '4':'....-', '5':'.....',
    '6':'-....', '7':'--...', '8':'---..', '9':'----.',
    '/':'-..-.', '?':'..--..', '.':'.-.-.-', ',':'--..--', '=':'-...-', '+':'.-.-.'
  };
  var FROM_MORSE = {};
  Object.keys(MORSE).forEach(function (k) {
    if (k.length === 1) FROM_MORSE[MORSE[k]] = k;
  });

  function $(id) { return document.getElementById(id); }
  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function bandById(id) {
    for (var i = 0; i < BANDS.length; i++) if (BANDS[i].id === id) return BANDS[i];
    return BANDS[2];
  }
  function bandForFreq(khz) {
    for (var i = 0; i < BANDS.length; i++) {
      if (khz >= BANDS[i].lo && khz <= BANDS[i].hi) return BANDS[i];
    }
    return null;
  }
  function formatMhz(khz) { return (khz / 1000).toFixed(3); }
  function parseMhz(v) {
    var n = parseFloat(v);
    if (!isFinite(n)) return 0;
    return n < 100 ? n * 1000 : n;
  }
  function haversineKm(a, b) {
    var dLat = (b.lat - a.lat) * DEG;
    var dLon = (b.lon - a.lon) * DEG;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function bearingDeg(a, b) {
    var y = Math.sin((b.lon - a.lon) * DEG) * Math.cos(b.lat * DEG);
    var x = Math.cos(a.lat * DEG) * Math.sin(b.lat * DEG) -
      Math.sin(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.cos((b.lon - a.lon) * DEG);
    return (Math.atan2(y, x) / DEG + 360) % 360;
  }
  function sunLatLon(date) {
    var start = Date.UTC(date.getUTCFullYear(), 0, 0);
    var doy = (date.getTime() - start) / 86400000;
    var lat = -23.44 * Math.cos((2 * Math.PI * (doy + 10)) / 365.24);
    var hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    var lon = 180 - hours * 15;
    lon = ((((lon + 180) % 360) + 360) % 360) - 180;
    return { lat: lat, lon: lon };
  }
  function latLonToVec(lat, lon) {
    var phi = (90 - lat) * DEG;
    var theta = (lon + 180) * DEG;
    return {
      x: -Math.sin(phi) * Math.cos(theta),
      y: Math.cos(phi),
      z: Math.sin(phi) * Math.sin(theta)
    };
  }
  function greatCircle(a, b, n) {
    var aV = latLonToVec(a.lat, a.lon);
    var bV = latLonToVec(b.lat, b.lon);
    var dot = clamp(aV.x * bV.x + aV.y * bV.y + aV.z * bV.z, -1, 1);
    var omega = Math.acos(dot);
    if (omega < 1e-5) return [a, b];
    var out = [];
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      var s0 = Math.sin((1 - t) * omega) / Math.sin(omega);
      var s1 = Math.sin(t * omega) / Math.sin(omega);
      var x = s0 * aV.x + s1 * bV.x;
      var y = s0 * aV.y + s1 * bV.y;
      var z = s0 * aV.z + s1 * bV.z;
      var lat = 90 - Math.acos(clamp(y, -1, 1)) / DEG;
      var lon = (Math.atan2(z, -x) / DEG) - 180;
      lon = ((((lon + 180) % 360) + 360) % 360) - 180;
      out.push({ lat: lat, lon: lon });
    }
    return out;
  }
  function hopCount(km, band) {
    if (band.nvis && km < 600) return 1;
    return Math.max(1, Math.min(4, Math.ceil(km / band.hopKm)));
  }
  function ditSeconds(wpm) { return 1.2 / Math.max(5, wpm); }
  function encodeMorse(text) {
    return text.toUpperCase().split('').map(function (ch) {
      if (ch === ' ') return '/';
      return MORSE[ch] || '';
    }).filter(Boolean).join(' ');
  }
  function utcStamp(ms) {
    var d = new Date(ms);
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
  }
  function utcDate(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  /* ── state ──────────────────────────────────────────────────────── */
  var state = {
    freqKhz: 14175,
    band: '20m',
    mode: 'SSB',
    af: 0.55,
    rf: 0.7,
    muted: false,
    wpm: 18,
    audioReady: false,
    keyed: false,
    sUnits: 1.2,
    selected: null,
    filterBand: '',
    filterMode: '',
    decoded: '',
    elements: '',
    rotLon: -118,
    rotLat: 18,
    log: [],
    generated: '',
    helpOpen: false
  };

  /* ── decoder ────────────────────────────────────────────────────── */
  var decoder = {
    elements: '',
    text: '',
    lastEdge: 0,
    down: false,
    key: function (down, t) {
      var dit = ditSeconds(state.wpm);
      if (down) {
        if (!this.down && this.lastEdge) {
          var gap = t - this.lastEdge;
          if (gap > dit * 6.2) this.flushWord();
          else if (gap > dit * 2.1) this.flushLetter();
        }
        this.down = true;
        this.lastEdge = t;
      } else if (this.down) {
        var dur = t - this.lastEdge;
        this.elements += dur < dit * 1.8 ? '.' : '-';
        this.down = false;
        this.lastEdge = t;
      }
    },
    tick: function (t) {
      if (this.down || !this.lastEdge) return;
      var dit = ditSeconds(state.wpm);
      var gap = t - this.lastEdge;
      if (this.elements && gap > dit * 2.1) this.flushLetter();
      if (gap > dit * 6.2 && this.text && this.text.charAt(this.text.length - 1) !== ' ') this.flushWord();
    },
    flushLetter: function () {
      if (!this.elements) return;
      this.text = (this.text + (FROM_MORSE[this.elements] || '·')).slice(-80);
      this.elements = '';
    },
    flushWord: function () {
      this.flushLetter();
      if (this.text && this.text.charAt(this.text.length - 1) !== ' ') this.text += ' ';
    },
    reset: function () {
      this.elements = '';
      this.text = '';
      this.lastEdge = 0;
      this.down = false;
    }
  };

  /* ── audio ──────────────────────────────────────────────────────── */
  var audio = {
    ctx: null,
    master: null,
    sfx: null,
    noiseGain: null,
    filter: null,
    voices: {},
    stationTimer: null,
    unlock: function () {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        state.audioReady = true;
        renderMeta();
        return;
      }
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ctx = new AC();
      var master = ctx.createGain();
      var sfx = ctx.createGain();
      master.gain.value = state.muted ? 0 : state.af * state.af;
      sfx.connect(master);
      master.connect(ctx.destination);

      var filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 700;
      filter.Q.value = 0.8;
      var noiseGain = ctx.createGain();
      noiseGain.gain.value = 0.03;
      var buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      var data = buf.getChannelData(0);
      for (var i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      var src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(filter);
      filter.connect(noiseGain);
      noiseGain.connect(sfx);
      src.start();

      this.ctx = ctx;
      this.master = master;
      this.sfx = sfx;
      this.noiseGain = noiseGain;
      this.filter = filter;
      this.voices.sidetone = this.makeVoice(600);
      this.voices.dx = this.makeVoice(572);
      ctx.resume();
      state.audioReady = true;
      renderMeta();
    },
    makeVoice: function (hz) {
      var osc = this.ctx.createOscillator();
      var gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(this.sfx);
      osc.start();
      return { osc: osc, gain: gain };
    },
    setAf: function () {
      if (!this.master) return;
      this.master.gain.setTargetAtTime(state.muted ? 0 : state.af * state.af, this.ctx.currentTime, 0.03);
    },
    sidetone: function (on) {
      var v = this.voices.sidetone;
      if (!v) return;
      v.gain.gain.setTargetAtTime(on ? 0.22 : 0, this.ctx.currentTime, on ? 0.004 : 0.008);
    },
    dx: function (on, level) {
      var v = this.voices.dx;
      if (!v) return;
      v.gain.gain.setTargetAtTime(on ? level : 0, this.ctx.currentTime, 0.01);
    },
    setNoise: function (level, hz) {
      if (!this.noiseGain || !this.filter) return;
      var t = this.ctx.currentTime;
      this.noiseGain.gain.setTargetAtTime(Math.max(0, level), t, 0.05);
      this.filter.frequency.setTargetAtTime(hz, t, 0.08);
    },
    now: function () { return this.ctx ? this.ctx.currentTime : 0; },
    sendMorse: function (text, voiceName, level) {
      if (!this.ctx) return 0;
      var v = this.voices[voiceName];
      if (!v) return 0;
      var code = encodeMorse(text);
      var dit = ditSeconds(state.wpm);
      var t = this.ctx.currentTime + 0.02;
      var tokens = code.split(' ');
      for (var i = 0; i < tokens.length; i++) {
        var token = tokens[i];
        if (token === '/') { t += dit * 7; continue; }
        for (var j = 0; j < token.length; j++) {
          var dur = token.charAt(j) === '-' ? dit * 3 : dit;
          v.gain.gain.setTargetAtTime(level, t, 0.004);
          t += dur;
          v.gain.gain.setTargetAtTime(0, t, 0.006);
          t += dit;
        }
        t += dit * 2;
      }
      return t - this.ctx.currentTime;
    },
    loopCall: function (call) {
      var self = this;
      if (this.stationTimer != null) {
        window.clearTimeout(this.stationTimer);
        this.stationTimer = null;
      }
      this.dx(false, 0);
      if (!call || !this.ctx || state.mode !== 'CW') return;
      function play() {
        if (!self.ctx) return;
        var dur = self.sendMorse('CQ DE ' + call + ' ' + call + ' K', 'dx', 0.12);
        self.stationTimer = window.setTimeout(function () {
          self.stationTimer = window.setTimeout(play, 2400);
        }, (dur + 0.1) * 1000);
      }
      play();
    }
  };

  /* ── iambic A + straight key ────────────────────────────────────── */
  var keyer = {
    ditDown: false,
    dahDown: false,
    sending: false,
    last: null,
    timer: null,
    startElement: function (kind) {
      var self = this;
      if (!audio.ctx) audio.unlock();
      var dit = ditSeconds(state.wpm);
      var dur = kind === 'dah' ? dit * 3 : dit;
      this.sending = true;
      this.last = kind;
      setKeyed(true);
      this.timer = window.setTimeout(function () {
        setKeyed(false);
        self.timer = window.setTimeout(function () {
          self.sending = false;
          self.queueNext();
        }, dit * 1000);
      }, dur * 1000);
    },
    queueNext: function () {
      if (this.ditDown && this.dahDown) {
        this.startElement(this.last === 'dit' ? 'dah' : 'dit');
      } else if (this.ditDown) {
        this.startElement('dit');
      } else if (this.dahDown) {
        this.startElement('dah');
      }
    },
    paddle: function (which, down) {
      if (which === 'dit') this.ditDown = down;
      else this.dahDown = down;
      if (down && !this.sending) this.startElement(which);
    },
    straight: function (down) {
      if (this.ditDown || this.dahDown) return;
      setKeyed(down);
    }
  };

  function setKeyed(down) {
    if (state.keyed === down) return;
    state.keyed = down;
    if (!audio.ctx) audio.unlock();
    audio.sidetone(down);
    decoder.key(down, audio.now() || performance.now() / 1000);
    renderPaddle();
  }

  /* ── receiver ───────────────────────────────────────────────────── */
  function setBand(id) {
    var b = bandById(id);
    state.band = b.id;
    if (state.freqKhz < b.lo || state.freqKhz > b.hi) state.freqKhz = b.center;
    renderReceiver();
    updateHeard();
  }
  function setFreq(khz) {
    var b = bandById(state.band);
    state.freqKhz = clamp(khz, b.lo, b.hi);
    renderReceiver();
    updateHeard();
  }
  function nudgeFreq(dkhz) { setFreq(state.freqKhz + dkhz); }
  function setMode(mode) {
    state.mode = mode;
    renderReceiver();
    updateHeard();
    if (state.selected && mode === 'CW') audio.loopCall(state.selected.call);
    else audio.loopCall(null);
  }

  function selectQso(id) {
    var q = null;
    for (var i = 0; i < state.log.length; i++) if (state.log[i].id === id) { q = state.log[i]; break; }
    state.selected = q;
    if (!q) { renderPath(); renderLog(); drawGlobe(); return; }
    var b = bandForFreq(q.freqKhz);
    if (b) state.band = b.id;
    else if (q.band) state.band = q.band;
    state.mode = q.mode === 'CW' ? 'CW' : (q.mode === 'FT8' || q.mode === 'FT4' ? 'FT8' : 'SSB');
    if (q.freqKhz) {
      var bb = bandById(state.band);
      state.freqKhz = clamp(q.freqKhz, bb.lo, bb.hi);
    }
    if (q.lat != null && q.myLat != null) {
      state.rotLon = (q.myLon + q.lon) / 2;
      state.rotLat = clamp((q.myLat + q.lat) / 2, -40, 50);
    }
    if (!audio.ctx) audio.unlock();
    audio.loopCall(state.mode === 'CW' ? q.call : null);
    renderReceiver();
    renderPath();
    renderLog();
    drawGlobe();
    updateHeard();
  }

  function updateHeard() {
    var best = null;
    for (var i = 0; i < state.log.length; i++) {
      var q = state.log[i];
      if (!q.freqKhz) continue;
      if (q.band && q.band !== state.band) continue;
      var df = Math.abs(q.freqKhz - state.freqKhz);
      if (df > 3.2) continue;
      if (state.mode === 'CW' && q.mode !== 'CW') continue;
      if (!best || df < best.df) best = { qso: q, df: df };
    }
    state.heard = best;
    var noise = 0.028 + (1 - state.rf) * 0.04;
    if (best) noise = 0.012 + best.df * 0.006;
    audio.setNoise(state.audioReady ? noise : 0, state.mode === 'CW' ? 600 : 900);
    if (best && state.mode === 'CW' && (!state.selected || state.selected.call !== best.qso.call)) {
      audio.loopCall(best.qso.call);
    }
    renderHeard();
  }

  function tickMeter() {
    var s = 1.1 + state.rf * 1.3;
    if (state.keyed) s = 9.2;
    else if (state.heard) {
      var peak = state.heard.qso.mode === 'CW' ? 8.4 : state.heard.qso.mode === 'FT8' ? 6.2 : 7.6;
      var detune = 1 - Math.min(1, state.heard.df / 2.4);
      s = 1.6 + peak * detune * (0.45 + state.rf * 0.55);
    }
    s += (Math.random() - 0.5) * 0.18;
    state.sUnits = clamp(s, 0.4, 9.6);
    renderMeter();
  }

  /* ── globe ──────────────────────────────────────────────────────── */
  function project(lat, lon, R) {
    var la = lat * DEG;
    var lo = (lon - state.rotLon) * DEG;
    var cl = Math.cos(la);
    return {
      x: R * cl * Math.sin(lo),
      y: -R * Math.sin(la - state.rotLat * DEG),
      z: cl * Math.cos(lo)
    };
  }

  function drawGlobe() {
    var canvas = $('desk-globe');
    if (!canvas) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var cssW = canvas.clientWidth || 640;
    var cssH = canvas.clientHeight || 280;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var w = cssW;
    var h = cssH;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0e1114';
    ctx.fillRect(0, 0, w, h);

    var cx = w * 0.38;
    var cy = h * 0.52;
    var R = Math.min(w * 0.34, h * 0.46);

    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = '#1a2430';
    ctx.fill();

    var sun = sunLatLon(new Date());
    var sunV = latLonToVec(sun.lat, sun.lon);

    /* night cap */
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(4,6,10,0.55)';
    var step = 4;
    for (var yy = -R; yy <= R; yy += step) {
      for (var xx = -R; xx <= R; xx += step) {
        var rr = xx * xx + yy * yy;
        if (rr > R * R) continue;
        var z = Math.sqrt(Math.max(0, 1 - rr / (R * R)));
        var xN = xx / R;
        var yN = -yy / R;
        /* invert project roughly: this is a cheap disk sample against sun */
        var lat = Math.asin(clamp(yN, -1, 1)) / DEG + state.rotLat;
        var lon = Math.atan2(xN, z) / DEG + state.rotLon;
        var p = latLonToVec(lat, lon);
        var day = p.x * sunV.x + p.y * sunV.y + p.z * sunV.z;
        if (day < 0.04) {
          ctx.fillRect(cx + xx, cy + yy, step, step);
        }
      }
    }
    ctx.restore();

    function strokePoly(ring, fill) {
      var started = false;
      ctx.beginPath();
      for (var i = 0; i < ring.length; i++) {
        var pt = project(ring[i][1], ring[i][0], R);
        if (pt.z <= 0) { started = false; continue; }
        if (!started) { ctx.moveTo(cx + pt.x, cy + pt.y); started = true; }
        else ctx.lineTo(cx + pt.x, cy + pt.y);
      }
      ctx.fillStyle = fill;
      ctx.fill();
    }
    for (var li = 0; li < LAND.length; li++) strokePoly(LAND[li], '#6a7a52');

    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = '#0a0a0a';
    ctx.lineWidth = 1.25;
    ctx.stroke();

    /* QSO dots */
    for (var qi = 0; qi < state.log.length; qi++) {
      var q = state.log[qi];
      if (q.lat == null || q.lon == null) continue;
      var qp = project(q.lat, q.lon, R);
      if (qp.z <= 0) continue;
      var sel = state.selected && state.selected.id === q.id;
      ctx.fillStyle = sel ? '#c8401a' : 'rgba(200,64,26,0.55)';
      ctx.beginPath();
      ctx.arc(cx + qp.x, cy + qp.y, sel ? 3.2 : 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    var home = project(QTH.lat, QTH.lon, R);
    if (home.z > 0) {
      ctx.fillStyle = '#f5f5f0';
      ctx.beginPath();
      ctx.arc(cx + home.x, cy + home.y, 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#0a0a0a';
      ctx.stroke();
    }

    if (state.selected && state.selected.lat != null) {
      var from = {
        lat: state.selected.myLat != null ? state.selected.myLat : QTH.lat,
        lon: state.selected.myLon != null ? state.selected.myLon : QTH.lon
      };
      var to = { lat: state.selected.lat, lon: state.selected.lon };
      var path = greatCircle(from, to, 64);
      ctx.beginPath();
      var pen = false;
      for (var pi = 0; pi < path.length; pi++) {
        var pp = project(path[pi].lat, path[pi].lon, R * 1.01);
        if (pp.z <= 0) { pen = false; continue; }
        if (!pen) { ctx.moveTo(cx + pp.x, cy + pp.y); pen = true; }
        else ctx.lineTo(cx + pp.x, cy + pp.y);
      }
      ctx.strokeStyle = '#c8401a';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    if (w >= 700) {
      ctx.fillStyle = '#f5f5f0';
      ctx.font = '11px Consolas, Menlo, monospace';
      ctx.fillText('SUN ' + sun.lat.toFixed(1) + ' / ' + sun.lon.toFixed(1), w * 0.72, 18);
      ctx.fillText('ROT ' + state.rotLon.toFixed(0) + '°', w * 0.72, 34);
      ctx.fillStyle = '#9aa';
      ctx.fillText(state.log.length + ' QSO dots', w * 0.72, 50);
      ctx.fillText('drag to rotate', w * 0.72, 66);
    }
  }

  /* ── render ─────────────────────────────────────────────────────── */
  function renderMeta() {
    var utc = Date.now();
    if ($('desk-utc')) $('desk-utc').textContent = utcStamp(utc);
    if ($('desk-date')) $('desk-date').textContent = utcDate(utc);
    if ($('desk-audio')) {
      $('desk-audio').textContent = state.audioReady ? 'LIVE' : 'LOCKED';
      $('desk-audio').classList.toggle('desk-warn', !state.audioReady);
    }
    var sun = sunLatLon(new Date(utc));
    if ($('desk-sun')) $('desk-sun').textContent = sun.lon.toFixed(0) + '°';
  }

  function renderReceiver() {
    if ($('desk-freq')) $('desk-freq').textContent = formatMhz(state.freqKhz);
    if ($('desk-band-read')) $('desk-band-read').textContent = state.band;
    var keys = document.querySelectorAll('[data-band]');
    for (var i = 0; i < keys.length; i++) {
      keys[i].setAttribute('data-on', keys[i].getAttribute('data-band') === state.band ? 'true' : 'false');
    }
    var modes = document.querySelectorAll('[data-mode]');
    for (var m = 0; m < modes.length; m++) {
      modes[m].setAttribute('data-on', modes[m].getAttribute('data-mode') === state.mode ? 'true' : 'false');
    }
    if ($('desk-af-read')) $('desk-af-read').textContent = Math.round(state.af * 100);
    if ($('desk-rf-read')) $('desk-rf-read').textContent = Math.round(state.rf * 100);
    if ($('desk-mute')) $('desk-mute').textContent = state.muted ? 'Unmute audio' : 'Mute audio';
    drawKnob();
  }

  function renderMeter() {
    var needle = $('desk-needle');
    if (!needle) return;
    var t = clamp(state.sUnits / 9.5, 0, 1);
    var angle = Math.PI - t * Math.PI;
    var x = 100 + Math.cos(angle) * 66;
    var y = 82 - Math.sin(angle) * 66;
    needle.setAttribute('x2', x.toFixed(1));
    needle.setAttribute('y2', y.toFixed(1));
    if ($('desk-sread')) {
      var u = Math.round(Math.min(9, state.sUnits));
      $('desk-sread').textContent = state.sUnits > 9 ? ('S9 +' + Math.round((state.sUnits - 9) * 10)) : ('S' + u);
    }
  }

  function renderPaddle() {
    if ($('desk-tape')) {
      var text = decoder.text || '';
      var el = decoder.elements || '';
      $('desk-tape').innerHTML =
        (text ? escapeHtml(text) : '<span class="desk-muted">send…</span>') +
        '<span class="desk-accent">' + escapeHtml(el) + '</span>' +
        (state.keyed ? '<span class="desk-good"> ▮</span>' : '');
    }
    if ($('desk-wpm-read')) $('desk-wpm-read').textContent = state.wpm + ' WPM';
    var pads = document.querySelectorAll('.desk-pad');
    for (var i = 0; i < pads.length; i++) {
      var which = pads[i].getAttribute('data-pad');
      var down = which === 'dit' ? keyer.ditDown : which === 'dah' ? keyer.dahDown : state.keyed;
      pads[i].setAttribute('data-down', down ? 'true' : 'false');
    }
  }

  function renderHeard() {
    if (!$('desk-heard')) return;
    if (state.heard) {
      $('desk-heard').textContent = state.heard.qso.call + '  ' + formatMhz(state.heard.qso.freqKhz) +
        '  Δ' + state.heard.df.toFixed(1) + ' kHz';
    } else {
      $('desk-heard').textContent = 'Noise floor';
    }
  }

  function renderPath() {
    var q = state.selected;
    if ($('desk-path-empty')) $('desk-path-empty').hidden = !!q;
    if ($('desk-path-facts')) $('desk-path-facts').hidden = !q;
    if (!q) return;
    var from = {
      lat: q.myLat != null ? q.myLat : QTH.lat,
      lon: q.myLon != null ? q.myLon : QTH.lon
    };
    var km = (q.lat != null) ? Math.round(haversineKm(from, q)) : q.km;
    var az = (q.lat != null) ? bearingDeg(from, q).toFixed(0) + '°' : '—';
    var hops = (km != null) ? String(hopCount(km, bandById(state.band))) : '—';
    setText('desk-dx-call', q.call);
    setText('desk-dx-name', q.name || '—');
    setText('desk-dx-qth', q.qth || '—');
    setText('desk-dx-grid', q.grid || '—');
    setText('desk-dx-km', km != null ? km.toLocaleString() + ' km' : '—');
    setText('desk-dx-az', az);
    setText('desk-dx-hops', hops);
    setText('desk-dx-rst', q.rst || '—');
  }

  function setText(id, v) { if ($(id)) $(id).textContent = v; }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
  }

  function filteredLog() {
    return state.log.filter(function (q) {
      if (state.filterBand && q.band !== state.filterBand) return false;
      if (state.filterMode && q.mode !== state.filterMode) return false;
      return true;
    });
  }

  function renderLog() {
    var body = $('desk-log-body');
    if (!body) return;
    var rows = filteredLog();
    if ($('desk-log-count')) {
      $('desk-log-count').textContent = rows.length + ' / ' + state.log.length +
        (state.generated ? ' · fetched ' + state.generated : '');
    }
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="7">No QSOs match the filter. The published book is the QRZ log, not a sample.</td></tr>';
      return;
    }
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var q = rows[i];
      var active = state.selected && state.selected.id === q.id;
      html += '<tr data-qso="' + escapeHtml(q.id) + '"' + (active ? ' data-active="true"' : '') + '>' +
        '<td>' + escapeHtml(q.date) + ' ' + escapeHtml(q.time) + '</td>' +
        '<td class="desk-call">' + escapeHtml(q.call) + '</td>' +
        '<td class="desk-hide-sm">' + escapeHtml(q.qth || '—') + '</td>' +
        '<td>' + escapeHtml(q.band || '—') + '</td>' +
        '<td>' + escapeHtml(q.mode || '—') + '</td>' +
        '<td class="desk-hide-md">' + (q.freqKhz ? formatMhz(q.freqKhz) : '—') + '</td>' +
        '<td class="desk-hide-lg">' + (q.km != null ? q.km.toLocaleString() : '—') + '</td>' +
        '</tr>';
    }
    body.innerHTML = html;
  }

  function drawKnob() {
    var canvas = $('desk-knob');
    if (!canvas) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var size = 112;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var c = size / 2;
    var r = 48;
    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.fillStyle = '#d8d4c8';
    ctx.fill();
    ctx.strokeStyle = '#0a0a0a';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    var b = bandById(state.band);
    var t = (state.freqKhz - b.lo) / (b.hi - b.lo);
    var a = -Math.PI * 0.75 + t * Math.PI * 1.5;
    for (var i = 0; i < 12; i++) {
      var aa = -Math.PI * 0.75 + (i / 11) * Math.PI * 1.5;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(aa) * 40, c + Math.sin(aa) * 40);
      ctx.lineTo(c + Math.cos(aa) * 46, c + Math.sin(aa) * 46);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c + Math.cos(a) * 36, c + Math.sin(a) * 36);
    ctx.strokeStyle = '#c8401a';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c, c, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#0a0a0a';
    ctx.fill();
  }

  /* ── log load ───────────────────────────────────────────────────── */
  function normalizeQso(raw, idx) {
    var freqKhz = parseMhz(raw.freq);
    var from = {
      lat: raw.my_lat != null ? raw.my_lat : QTH.lat,
      lon: raw.my_lon != null ? raw.my_lon : QTH.lon
    };
    var km = (raw.lat != null && raw.lon != null) ? Math.round(haversineKm(from, raw)) : null;
    var qth = [raw.county, raw.state, raw.country].filter(Boolean).join(', ');
    if (!qth) qth = raw.country || '';
    return {
      id: (raw.date || '') + '-' + (raw.time || '') + '-' + (raw.call || idx),
      date: raw.date || '',
      time: raw.time || '',
      call: raw.call || '',
      name: raw.first_name || raw.name || '',
      qth: qth,
      grid: raw.gridsquare || '',
      band: raw.band || (bandForFreq(freqKhz) ? bandForFreq(freqKhz).id : ''),
      mode: raw.mode || 'SSB',
      freqKhz: freqKhz,
      rst: raw.rst_rcvd || raw.rst_sent || '',
      lat: raw.lat,
      lon: raw.lon,
      myLat: raw.my_lat,
      myLon: raw.my_lon,
      km: km
    };
  }

  function loadLog() {
    fetch('/data/qso-log.json', { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('log ' + r.status); return r.json(); })
      .then(function (data) {
        state.generated = data.generated || '';
        state.log = (data.qsos || []).map(normalizeQso);
        if ($('desk-log-source')) {
          $('desk-log-source').textContent = 'QRZ Logbook · ' + state.log.length + ' QSOs · same file as /log/';
        }
        renderLog();
        drawGlobe();
        updateHeard();
      })
      .catch(function () {
        if ($('desk-log-source')) $('desk-log-source').textContent = 'Could not load /data/qso-log.json';
        if ($('desk-log-body')) {
          $('desk-log-body').innerHTML = '<tr><td colspan="7">Log fetch failed. The console still keys and draws the grayline; it will not invent contacts.</td></tr>';
        }
      });
  }

  /* ── events ─────────────────────────────────────────────────────── */
  function bindPad(el, which) {
    if (!el) return;
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      audio.unlock();
      if (which === 'key') keyer.straight(true);
      else keyer.paddle(which, true);
      renderPaddle();
    });
    function up() {
      if (which === 'key') keyer.straight(false);
      else keyer.paddle(which, false);
      renderPaddle();
    }
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }

  function bindKnob() {
    var canvas = $('desk-knob');
    if (!canvas) return;
    var dragging = false;
    var lastAng = 0;
    function ang(e) {
      var rect = canvas.getBoundingClientRect();
      return Math.atan2(e.clientY - (rect.top + rect.height / 2), e.clientX - (rect.left + rect.width / 2));
    }
    canvas.addEventListener('pointerdown', function (e) {
      dragging = true;
      lastAng = ang(e);
      canvas.setPointerCapture(e.clientX ? e.pointerId : 0);
      audio.unlock();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var a = ang(e);
      var d = a - lastAng;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      lastAng = a;
      nudgeFreq(d * 40);
    });
    canvas.addEventListener('pointerup', function () { dragging = false; });
    canvas.addEventListener('pointercancel', function () { dragging = false; });
  }

  function bindGlobe() {
    var canvas = $('desk-globe');
    if (!canvas) return;
    var dragging = false;
    var lastX = 0;
    var lastY = 0;
    canvas.addEventListener('pointerdown', function (e) {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      state.rotLon -= (e.clientX - lastX) * 0.35;
      state.rotLat = clamp(state.rotLat + (e.clientY - lastY) * 0.2, -50, 50);
      lastX = e.clientX;
      lastY = e.clientY;
      drawGlobe();
    });
    canvas.addEventListener('pointerup', function () { dragging = false; });
    canvas.addEventListener('pointercancel', function () { dragging = false; });
  }

  function onKeyDown(e) {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.repeat && (e.code === 'Space' || e.code === 'KeyZ' || e.code === 'KeyX')) {
      e.preventDefault();
      return;
    }
    audio.unlock();
    if (e.code === 'Space') { e.preventDefault(); keyer.straight(true); renderPaddle(); }
    else if (e.code === 'KeyZ') { e.preventDefault(); keyer.paddle('dit', true); renderPaddle(); }
    else if (e.code === 'KeyX') { e.preventDefault(); keyer.paddle('dah', true); renderPaddle(); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); nudgeFreq(e.shiftKey ? -1 : -0.1); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); nudgeFreq(e.shiftKey ? 1 : 0.1); }
    else if (e.key === '1') setBand('80m');
    else if (e.key === '2') setBand('40m');
    else if (e.key === '3') setBand('20m');
    else if (e.key === '4') setBand('15m');
    else if (e.key === '5') setBand('10m');
    else if (e.key === '6') setBand('6m');
    else if (e.key === 'c' || e.key === 'C') setMode('CW');
    else if (e.key === 's' || e.key === 'S') setMode('SSB');
    else if (e.key === 'f' || e.key === 'F') setMode('FT8');
    else if (e.key === 'm' || e.key === 'M') {
      state.muted = !state.muted;
      audio.setAf();
      renderReceiver();
    } else if (e.key === '?' || (e.shiftKey && e.key === '/')) {
      state.helpOpen = !state.helpOpen;
      if ($('desk-help')) $('desk-help').hidden = !state.helpOpen;
    }
  }
  function onKeyUp(e) {
    if (e.code === 'Space') { e.preventDefault(); keyer.straight(false); renderPaddle(); }
    else if (e.code === 'KeyZ') { keyer.paddle('dit', false); renderPaddle(); }
    else if (e.code === 'KeyX') { keyer.paddle('dah', false); renderPaddle(); }
  }

  function init() {
    var i;
    var bandBtns = document.querySelectorAll('[data-band]');
    for (i = 0; i < bandBtns.length; i++) {
      bandBtns[i].addEventListener('click', function () { audio.unlock(); setBand(this.getAttribute('data-band')); });
    }
    var modeBtns = document.querySelectorAll('[data-mode]');
    for (i = 0; i < modeBtns.length; i++) {
      modeBtns[i].addEventListener('click', function () { audio.unlock(); setMode(this.getAttribute('data-mode')); });
    }
    var steps = document.querySelectorAll('[data-step]');
    for (i = 0; i < steps.length; i++) {
      steps[i].addEventListener('click', function () { audio.unlock(); nudgeFreq(parseFloat(this.getAttribute('data-step'))); });
    }
    if ($('desk-af')) {
      $('desk-af').addEventListener('input', function () {
        state.af = parseFloat(this.value);
        audio.setAf();
        renderReceiver();
      });
    }
    if ($('desk-rf')) {
      $('desk-rf').addEventListener('input', function () {
        state.rf = parseFloat(this.value);
        renderReceiver();
        updateHeard();
      });
    }
    if ($('desk-wpm')) {
      $('desk-wpm').addEventListener('input', function () {
        state.wpm = parseInt(this.value, 10) || 18;
        renderPaddle();
      });
    }
    if ($('desk-mute')) {
      $('desk-mute').addEventListener('click', function () {
        state.muted = !state.muted;
        audio.setAf();
        renderReceiver();
      });
    }
    if ($('desk-clear')) {
      $('desk-clear').addEventListener('click', function () {
        decoder.reset();
        renderPaddle();
      });
    }
    if ($('desk-cq')) {
      $('desk-cq').addEventListener('click', function () {
        audio.unlock();
        audio.sendMorse('CQ CQ DE N6CBL N6CBL K', 'sidetone', 0.2);
      });
    }
    if ($('desk-filter-band')) {
      $('desk-filter-band').addEventListener('change', function () {
        state.filterBand = this.value;
        renderLog();
      });
    }
    if ($('desk-filter-mode')) {
      $('desk-filter-mode').addEventListener('change', function () {
        state.filterMode = this.value;
        renderLog();
      });
    }
    if ($('desk-log-body')) {
      $('desk-log-body').addEventListener('click', function (e) {
        var tr = e.target.closest('tr[data-qso]');
        if (!tr) return;
        audio.unlock();
        selectQso(tr.getAttribute('data-qso'));
      });
    }
    if ($('desk-unlock')) {
      $('desk-unlock').addEventListener('click', function () { audio.unlock(); });
    }
    bindPad($('desk-dit'), 'dit');
    bindPad($('desk-dah'), 'dah');
    bindPad($('desk-key'), 'key');
    bindKnob();
    bindGlobe();
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('pointerdown', function () { audio.unlock(); }, { once: true });
    window.addEventListener('resize', drawGlobe);

    renderReceiver();
    renderPaddle();
    renderPath();
    renderMeta();
    drawGlobe();
    loadLog();

    window.setInterval(function () {
      var t = audio.now() || performance.now() / 1000;
      decoder.tick(t);
      state.decoded = decoder.text;
      state.elements = decoder.elements;
      renderPaddle();
      renderMeta();
      tickMeter();
    }, 80);
    window.setInterval(drawGlobe, 15000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
