// Shared helpers for the audio test scripts (tools/audio-*.mjs).
// Opens a bare same-origin page (no game loop running), installs node-count instrumentation,
// and provides (a) a ScriptProcessor tap for real-time captures and (b) OfflineAudioContext helpers
// (deterministic, faster than real time) with an A-weighted loudness analyser.
import { launch, sleep } from './harness.mjs';

export { sleep };

// Runs inside the page: counts node creation and full disconnects per node class.
// Patches BaseAudioContext so both AudioContext and OfflineAudioContext are counted.
export function installProbe() {
  const P = (window.__probe = { created: {}, disc: {} });
  const AC = window.BaseAudioContext;
  const fns = ['createOscillator', 'createBufferSource', 'createGain', 'createBiquadFilter', 'createStereoPanner',
    'createConvolver', 'createDelay', 'createDynamicsCompressor', 'createAnalyser', 'createBuffer', 'createWaveShaper', 'createScriptProcessor'];
  for (const m of fns) {
    const orig = AC.prototype[m];
    if (!orig) continue;
    AC.prototype[m] = function (...a) {
      const n = orig.apply(this, a);
      const k = n.constructor.name;
      P.created[k] = (P.created[k] || 0) + 1;
      return n;
    };
  }
  const od = AudioNode.prototype.disconnect;
  AudioNode.prototype.disconnect = function (...a) {
    if (a.length === 0 && !this.__d) { this.__d = 1; const k = this.constructor.name; P.disc[k] = (P.disc[k] || 0) + 1; }
    return od.apply(this, a);
  };
  P.live = () => {
    const o = {};
    for (const k in P.created) if (k !== 'AudioBuffer') o[k] = P.created[k] - (P.disc[k] || 0);
    return o;
  };
  P.liveTotal = () => Object.values(P.live()).reduce((s, v) => s + v, 0);
  P.reset = () => { P.created = {}; P.disc = {}; };
  window.__wait = (ms) => new Promise((r) => setTimeout(r, ms));
}

// Runs inside the page: tap a node of the engine and record per-buffer stats (real-time).
export function installCapture(engine, key = 'post', tapName = 'out') {
  const ctx = engine.ctx;
  const sp = ctx.createScriptProcessor(1024, 1, 1);
  const rec = [];
  let prev = 0;
  sp.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0);
    let pk = 0, ss = 0, md = 0;
    for (let i = 0; i < d.length; i++) {
      const v = d[i], av = v < 0 ? -v : v;
      if (av > pk) pk = av;
      ss += v * v;
      const dd = Math.abs(v - prev); if (dd > md) md = dd;
      prev = v;
    }
    rec.push({ t: e.playbackTime, pk, rms: Math.sqrt(ss / d.length), md });
  };
  engine[tapName].connect(sp);
  const sink = ctx.createGain(); sink.gain.value = 0; sp.connect(sink); sink.connect(ctx.destination);
  (window.__caps = window.__caps || {})[key] = window.__cap = {
    rec,
    query(t0, t1) {
      let pk = 0, ss = 0, n = 0, md = 0;
      for (const r of rec) if (r.t >= t0 && r.t <= t1) { if (r.pk > pk) pk = r.pk; ss += r.rms * r.rms; n++; if (r.md > md) md = r.md; }
      return { peak: pk, rms: n ? Math.sqrt(ss / n) : 0, maxDelta: md, n };
    },
  };
}

// Runs inside the page: OfflineAudioContext engine factory + analyser.
export function installOffline() {
  const SR = 48000;
  // A-weighting as 3 biquads (bilinear transform), normalised to 0 dB at 1 kHz.
  function bq(b, a, c) {
    const [b2, b1, b0] = b, [a2, a1, a0] = a;
    const n0 = b2 * c * c + b1 * c + b0, n1 = -2 * b2 * c * c + 2 * b0, n2 = b2 * c * c - b1 * c + b0;
    const d0 = a2 * c * c + a1 * c + a0, d1 = -2 * a2 * c * c + 2 * a0, d2 = a2 * c * c - a1 * c + a0;
    return { b0: n0 / d0, b1: n1 / d0, b2: n2 / d0, a1: d1 / d0, a2: d2 / d0 };
  }
  const W = (f) => 2 * Math.PI * f;
  const w1 = W(20.598997), w2 = W(107.65265), w3 = W(737.86223), w4 = W(12194.217), c = 2 * SR;
  const secs = [
    bq([1, 0, 0], [1, 2 * w1, w1 * w1], c),
    bq([1, 0, 0], [1, w2 + w3, w2 * w3], c),
    bq([0, 0, w4 * w4], [1, 2 * w4, w4 * w4], c),
  ];
  function mag(sec, f) {
    const w = 2 * Math.PI * f / SR, re = (x) => Math.cos(x * w), im = (x) => -Math.sin(x * w);
    const nr = sec.b0 + sec.b1 * re(1) + sec.b2 * re(2), ni = sec.b1 * im(1) + sec.b2 * im(2);
    const dr = 1 + sec.a1 * re(1) + sec.a2 * re(2), di = sec.a1 * im(1) + sec.a2 * im(2);
    return Math.hypot(nr, ni) / Math.hypot(dr, di);
  }
  const norm = 1 / (mag(secs[0], 1000) * mag(secs[1], 1000) * mag(secs[2], 1000));
  function aWeight(x) {
    let y = x;
    for (const s of secs) {
      const o = new Float32Array(y.length);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < y.length; i++) {
        const xi = y[i];
        const yi = s.b0 * xi + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
        x2 = x1; x1 = xi; y2 = y1; y1 = yi; o[i] = yi;
      }
      y = o;
    }
    for (let i = 0; i < y.length; i++) y[i] *= norm;
    return y;
  }
  const db = (v) => (v > 1e-9 ? 20 * Math.log10(v) : -180);
  // max sliding-window RMS (win seconds), dBFS
  function maxWin(x, win) {
    const n = Math.max(1, Math.round(win * SR)), step = Math.max(1, n >> 2);
    let best = 0;
    for (let i = 0; i + n <= x.length; i += step) {
      let s = 0;
      for (let j = i; j < i + n; j++) s += x[j] * x[j];
      if (s > best) best = s;
    }
    return db(Math.sqrt(best / n));
  }
  window.__analyze = function (buf, opt = {}) {
    const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    let pk = 0, md = 0, sl = 0, sr = 0, dc = 0, nan = 0, pkAt = 0;
    for (let i = 0; i < L.length; i++) {
      const a = Math.abs(L[i]), b = Math.abs(R[i]);
      if (a !== a || b !== b) nan++;
      if (a > pk) { pk = a; pkAt = i; } if (b > pk) { pk = b; pkAt = i; }
      sl += L[i] * L[i]; sr += R[i] * R[i]; dc += L[i] + R[i];
      if (i) { const d = Math.max(Math.abs(L[i] - L[i - 1]), Math.abs(R[i] - R[i - 1])); if (d > md) md = d; }
    }
    const aL = aWeight(L), aR = aWeight(R);
    const mono = new Float32Array(L.length), amono = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) { mono[i] = (L[i] + R[i]) * 0.5; amono[i] = (aL[i] + aR[i]) * 0.5; }
    // tail: last 50 ms window above -55 dBFS
    const n50 = Math.round(0.05 * SR);
    let tail = 0;
    for (let i = 0; i + n50 <= mono.length; i += n50) {
      let s = 0; for (let j = i; j < i + n50; j++) s += mono[j] * mono[j];
      if (db(Math.sqrt(s / n50)) > -55) tail = (i + n50) / SR;
    }
    return {
      peak: +pk.toFixed(3), pkAt: +(pkAt / SR - 0.3).toFixed(2), lmax: +maxWin(mono, 0.1).toFixed(1), lamax: +maxWin(amono, 0.1).toFixed(1),
      rms: +Math.sqrt((sl + sr) / (2 * L.length)).toFixed(4), tail: +tail.toFixed(2), maxDelta: +md.toFixed(3),
      dc: +(dc / (2 * L.length)).toFixed(5), lr: +db(Math.sqrt(sl / Math.max(1e-12, sr))).toFixed(1), nan,
    };
  };
  // Build an engine on an OfflineAudioContext. state is forced to 'running' (offline contexts report suspended).
  window.__mkOffline = function (AudioEngine, seconds, opts = {}) {
    const off = new OfflineAudioContext(2, Math.ceil(SR * seconds), SR);
    Object.defineProperty(off, 'state', { get: () => 'running' });
    const Real = window.AudioContext;
    window.AudioContext = function () { return off; };
    const a = new AudioEngine();
    if (opts.volume !== undefined) a.volume = opts.volume;
    if (opts.musicVol !== undefined) a.musicVol = opts.musicVol;
    if (opts.muted) a.muted = true;
    try { a.init(); } finally { window.AudioContext = Real; }
    // A DynamicsCompressor fed from the very first sample of an offline render reports ~12 dB too little output (start-up artefact
    // that real-time contexts and later onsets do not show): schedule everything after a short lead-in of silence.
    const LEAD = opts.lead === undefined ? 0.3 : opts.lead;
    a.now = () => off.currentTime + LEAD;
    if (opts.comp && a.comp) for (const k in opts.comp) a.comp[k].value = opts.comp[k]; // experiments: --comp=threshold,ratio,knee,attack,release
    if (opts.nolim && a.pre) a.pre.gain.value = 1, a.out.curve = null; // bypass the safety limiter: shows what the compressor alone delivers
    if (!opts.bed && a.drone) { a.drone.out.disconnect(); a.__nobed = true; } // cut the bed from the mix (tick() keeps ramping its gain)
    return { a, off };
  };
  // Run fn(a, t) at audio times stepping by `step` seconds, rendering `seconds` total; returns the rendered buffer.
  window.__runOffline = async function (AudioEngine, seconds, step, fn, opts = {}) {
    const { a, off } = window.__mkOffline(AudioEngine, seconds, opts);
    if (opts.setup) opts.setup(a);
    let t = 0;
    const next = () => {
      t += step;
      if (t >= seconds) return;
      off.suspend(t).then(() => { fn(a, off.currentTime); next(); off.resume(); });
    };
    fn(a, 0);
    next();
    const buf = await off.startRendering();
    return { a, off, buf };
  };
}

export async function openPage() {
  const h = await launch();
  await h.page.goto(h.url + '/css/style.css', { waitUntil: 'load' });
  await h.page.evaluate(installProbe);
  await h.page.addScriptTag({ content: 'window.__installCapture = ' + installCapture.toString() });
  await h.page.evaluate(installOffline);
  return h;
}

export function table(rows, cols) {
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (vals) => vals.map((v, i) => String(v).padEnd(w[i])).join('  ');
  console.log(line(cols));
  console.log(w.map((x) => '-'.repeat(x)).join('  '));
  for (const r of rows) console.log(line(cols.map((c) => r[c] ?? '')));
}
