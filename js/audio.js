// Fully synthesized soundscape (Web Audio). No samples, no assets.
// Every method is a safe no-op until init() succeeds and while the context is not running, so the game never depends on audio.
// Signal path: voices -> sfx/music buses (+ reverb, echo) -> compressor -> master (volume/mute) -> safety limiter (ceiling 0.88) -> out.

const ROOTS = [55.0, 49.0, 46.25, 41.2];          // A1, G1, F#1, E1 per biome
const SCALE = [0, 3, 5, 7, 10, 12, 15, 17, 19];   // minor pentatonic-ish
const PEARL_SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
// drone colour per biome: [fifth-ish interval ratio, lowpass cutoff Hz, ocean-rumble gain]
const COLOR = [[1.5, 300, 0.1], [1.189, 270, 0.12], [1.414, 250, 0.14], [1.06, 230, 0.16]];
const CAP = 70, LO_CAP = 44;                      // voice caps (ambience/music yields first)

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (typeof v === 'number' && v - v === 0 ? v : d);   // finite number or default (never NaN into an AudioParam)

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ok = false;
    this.volume = 0.8;
    this.musicVol = 0.7;
    this.muted = false;
    this.voices = 0;
    this.errors = 0; this.lastError = null;
    this.biome = 0;
    this.depth = 1;
    this.danger = 0; this.dangerAge = 0; this.dg = 0; // dg: danger as heard (fades if the game stops reporting it)
    this.musicT = 2;
    this.whaleT = rand(25, 45);
    this.beatT = 0;
    this.pearlStreak = 0;
    this.pearlT = 0;
    this.chargeVoice = null;
    this.drone = null;
    this.droneT = -1;
    this.wantRun = true; this.pendingSuspend = false;
  }

  /* ---------- lifecycle ---------- */
  get live() { return this.ok && this.ctx.state === 'running'; }

  init() {
    if (this.ctx) { this.resume(); return this.ok; }
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return false;
    try {
      const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));
      // buses -> compressor -> master (volume/mute: dynamics do not depend on the slider) -> soft limiter -> out
      this.bus = ctx.createGain();
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -20; this.comp.knee.value = 20; this.comp.ratio.value = 6;
      this.comp.attack.value = 0.003; this.comp.release.value = 0.25;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      // safety limiter: identity below 0.7, smooth saturation above, ceiling 0.88 for any input up to +-2 (the shaper sees half the signal): never digital clipping
      this.pre = ctx.createGain(); this.pre.gain.value = 0.5;
      this.out = ctx.createWaveShaper();
      const N = 2048, curve = new Float32Array(N);
      for (let i = 0; i < N; i++) { const x = ((i / (N - 1)) * 2 - 1) * 2, a = Math.abs(x); curve[i] = a < 0.7 ? x : Math.sign(x) * (0.7 + 0.18 * Math.tanh((a - 0.7) / 0.18)); }
      this.out.curve = curve;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.bus.connect(this.comp); this.comp.connect(this.master); this.master.connect(this.pre); this.pre.connect(this.out);
      this.out.connect(ctx.destination);
      this.out.connect(this.analyser);

      this.sfx = ctx.createGain(); this.sfx.gain.value = 1; this.sfx.connect(this.bus);
      this.musicBus = ctx.createGain(); this.musicBus.gain.value = this.musicVol; this.musicBus.connect(this.bus);

      // cave reverb: the convolver is the single most expensive node (about half of the engine's CPU), so weaker devices get a shorter impulse
      const nav = typeof navigator !== 'undefined' ? navigator : {}, cores = nav.hardwareConcurrency || 4;
      const weak = cores <= 2 || /Mobi|Android|iPhone|iPad/i.test(nav.userAgent || '');
      this.verb = ctx.createConvolver();
      this.verb.buffer = this.makeImpulse(weak ? 2.2 : cores <= 4 ? 2.9 : 3.6, 2.2);
      this.verbSend = ctx.createGain(); this.verbSend.gain.value = 1;
      this.verbOut = ctx.createGain(); this.verbOut.gain.value = 0.7;
      this.verbSend.connect(this.verb); this.verb.connect(this.verbOut); this.verbOut.connect(this.bus);

      // ping echo (dark feedback delay feeding the reverb)
      this.delay = ctx.createDelay(1.5); this.delay.delayTime.value = 0.34;
      this.fb = ctx.createGain(); this.fb.gain.value = 0.38;
      this.dlp = ctx.createBiquadFilter(); this.dlp.type = 'lowpass'; this.dlp.frequency.value = 1700;
      this.delaySend = ctx.createGain(); this.delaySend.gain.value = 1;
      this.delaySend.connect(this.delay); this.delay.connect(this.dlp);
      this.dlp.connect(this.fb); this.fb.connect(this.delay);
      this.dlp.connect(this.verbSend);
      const dOut = ctx.createGain(); dOut.gain.value = 0.55; this.dlp.connect(dOut); dOut.connect(this.bus);

      // music's own reverb/echo sends, scaled by the music volume (so the slider silences the wet signal too)
      this.mVerb = ctx.createGain(); this.mVerb.gain.value = this.musicVol; this.mVerb.connect(this.verbSend);
      this.mDelay = ctx.createGain(); this.mDelay.gain.value = this.musicVol; this.mDelay.connect(this.delaySend);

      // shared noise buffer
      const len = ctx.sampleRate * 2;
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) { // pink-ish
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
      }
      this.ok = true;
      this.startDrone();
      ctx.onstatechange = () => { if (ctx.state === 'running') this.disarmUnlock(); else this.armUnlock(); };
      this.resume();
      this.armUnlock();
    } catch (err) {
      console.warn('audio unavailable', err);
      this.ok = false;
      try { if (this.ctx && this.ctx.close) this.ctx.close().catch(() => {}); } catch (e) { /* noop */ }
      this.ctx = null; this.drone = null; // a later init() may try again
    }
    return this.ok;
  }

  // a context created before a user gesture starts suspended (and iOS/Safari can interrupt it later): while it is not
  // running, the next user gesture resumes it, whoever created it and however it got there
  armUnlock() {
    if (typeof window === 'undefined' || !window.addEventListener || this.unlockFn || this.ctx.state === 'running') return;
    const evs = ['pointerdown', 'keydown', 'touchend', 'mousedown'];
    const fn = () => this.resume();
    this.unlockFn = fn;
    evs.forEach((e) => window.addEventListener(e, fn, true));
  }
  disarmUnlock() {
    if (!this.unlockFn) return;
    ['pointerdown', 'keydown', 'touchend', 'mousedown'].forEach((e) => window.removeEventListener(e, this.unlockFn, true));
    this.unlockFn = null;
  }

  // resume()/suspend() may be called back to back (tab hidden then shown within a frame): the last call wins
  resume() {
    this.wantRun = true;
    const c = this.ctx;
    if (!c || this.pendingSuspend) return; // the suspend in flight resumes us when it lands
    if (c.state === 'suspended' || c.state === 'interrupted') { try { const p = c.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* noop */ } }
  }
  suspend() {
    this.wantRun = false;
    const c = this.ctx;
    if (!c || this.pendingSuspend || c.state !== 'running') return;
    const done = () => { this.pendingSuspend = false; if (this.wantRun) this.resume(); };
    this.pendingSuspend = true;
    try { const p = c.suspend(); if (p && p.then) p.then(done, done); else done(); } catch (e) { done(); }
  }

  setVolumes(master, music) {
    if (master !== undefined) this.volume = clamp(num(master, this.volume), 0, 1);
    if (music !== undefined) this.musicVol = clamp(num(music, this.musicVol), 0, 1);
    if (!this.ok) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, t, 0.04);
    this.musicBus.gain.setTargetAtTime(this.musicVol, t, 0.1);
    this.mVerb.gain.setTargetAtTime(this.musicVol, t, 0.1);
    this.mDelay.gain.setTargetAtTime(this.musicVol, t, 0.1);
  }
  setMuted(m) { this.muted = !!m; this.setVolumes(); }

  makeImpulse(dur, decay) {
    const ctx = this.ctx, rate = ctx.sampleRate, len = (rate * dur) | 0;
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let lp = 0, env = 1;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        if ((i & 31) === 0) env = Math.pow(1 - t, decay); // envelope per 32 samples: same tail, a third of the init cost
        lp += ((Math.random() * 2 - 1) - lp) * (0.62 - 0.55 * t); // gets darker as it decays
        data[i] = lp * env * (i < 200 ? i / 200 : 1);
      }
    }
    return buf;
  }

  /* ---------- voice helpers ---------- */
  now() { return this.ctx.currentTime; }

  route(node, { pan = 0, send = 0, dsend = 0, bus = 'sfx' }) {
    const ctx = this.ctx;
    let out = node;
    let panner = null;
    pan = clamp(num(pan, 0), -1, 1);
    if (pan && ctx.createStereoPanner) {
      panner = ctx.createStereoPanner(); panner.pan.value = pan;
      out.connect(panner); out = panner;
    }
    const mus = bus === 'music';
    out.connect(mus ? this.musicBus : this.sfx);
    const nodes = [panner];
    if (send > 0) { const s = ctx.createGain(); s.gain.value = send; out.connect(s); s.connect(mus ? this.mVerb : this.verbSend); nodes.push(s); }
    if (dsend > 0) { const s = ctx.createGain(); s.gain.value = dsend; out.connect(s); s.connect(mus ? this.mDelay : this.delaySend); nodes.push(s); }
    return nodes.filter(Boolean);
  }

  // one oscillator voice with an AD envelope (o.lo: ambience/music, yields to gameplay sounds when voices run short)
  tone(o) {
    if (!this.live || this.voices >= (o.lo ? LO_CAP : CAP)) return null;
    const peak = o.gain === undefined ? 0.2 : num(o.gain, 0);
    if (!(peak >= 0.0008)) return null; // inaudible: do not spend nodes on it
    const ctx = this.ctx;
    const t0 = this.now() + num(o.t, 0);
    const a = Math.max(0.001, num(o.a, 0.005)), d = Math.max(0.01, num(o.d, 0.3)), f = Math.max(1, num(o.f, 440));
    const nodes = [];
    try {
      const osc = ctx.createOscillator(); nodes.push(osc);
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(f, t0);
      if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(1, num(o.f2, f)), t0 + Math.max(0.001, num(o.glide, a + d)));
      if (o.detune) osc.detune.value = num(o.detune, 0);
      const g = ctx.createGain(); nodes.push(g);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
      if (o.lp) {
        const lf = ctx.createBiquadFilter(); nodes.push(lf); lf.type = 'lowpass'; lf.frequency.setValueAtTime(Math.max(20, num(o.lp, 1000)), t0);
        if (o.lp2) lf.frequency.exponentialRampToValueAtTime(Math.max(20, num(o.lp2, 200)), t0 + a + d);
        osc.connect(lf); lf.connect(g);
      } else osc.connect(g);
      nodes.push(...this.route(g, o));
      this.voices++;
      osc.start(t0);
      osc.stop(t0 + a + d + 0.08);
      osc.onended = () => {
        this.voices--;
        try { nodes.forEach((n) => n.disconnect()); } catch (e) { /* noop */ }
      };
      return osc;
    } catch (e) { this.fail(e, nodes); return null; }
  }

  // filtered noise burst
  noise(o) {
    if (!this.live || this.voices >= (o.lo ? LO_CAP : CAP)) return null;
    const peak = o.gain === undefined ? 0.2 : num(o.gain, 0);
    if (!(peak >= 0.0008)) return null;
    const ctx = this.ctx;
    const t0 = this.now() + num(o.t, 0);
    const a = Math.max(0.001, num(o.a, 0.004)), d = Math.max(0.01, num(o.d, 0.2));
    const nodes = [];
    try {
      const src = ctx.createBufferSource(); nodes.push(src);
      src.buffer = this.noiseBuf; src.loop = true;
      const f = ctx.createBiquadFilter(); nodes.push(f);
      f.type = o.type || 'bandpass';
      f.frequency.setValueAtTime(Math.max(20, num(o.f, 1000)), t0);
      if (o.f2) f.frequency.exponentialRampToValueAtTime(Math.max(20, num(o.f2, 100)), t0 + a + d);
      f.Q.value = num(o.q, 1);
      const g = ctx.createGain(); nodes.push(g);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
      src.connect(f); f.connect(g);
      nodes.push(...this.route(g, o));
      this.voices++;
      src.start(t0, Math.random() * 1.5);
      src.stop(t0 + a + d + 0.08);
      src.onended = () => {
        this.voices--;
        try { nodes.forEach((n) => n.disconnect()); } catch (e) { /* noop */ }
      };
      return src;
    } catch (e) { this.fail(e, nodes); return null; }
  }

  // a sound failed half-built: drop its nodes, count it (tests assert errors === 0), never let audio break the game
  fail(e, nodes) {
    this.errors++; this.lastError = e;
    try { nodes.forEach((n) => n.disconnect()); } catch (e2) { /* noop */ }
  }

  bell(f, o = {}) {
    const t = o.t || 0, g = o.gain ?? 0.12, d = o.d ?? 1.4;
    this.tone({ f, type: 'sine', t, a: 0.004, d, gain: g, pan: o.pan, send: o.send ?? 0.7, dsend: o.dsend ?? 0.15, bus: o.bus });
    this.tone({ f: f * 2.756, type: 'sine', t, a: 0.003, d: d * 0.35, gain: g * 0.32, pan: o.pan, send: o.send ?? 0.7, bus: o.bus });
    this.tone({ f: f * 5.4, type: 'sine', t, a: 0.002, d: d * 0.12, gain: g * 0.12, pan: o.pan, send: o.send ?? 0.7, bus: o.bus });
  }

  /* ---------- ambience ---------- */
  startDrone() {
    if (!this.ok || this.drone) return;
    const ctx = this.ctx;
    const b = this.biome, root = ROOTS[b], col = COLOR[b];
    const out = ctx.createGain(); out.gain.value = 0;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = col[1]; lp.Q.value = 0.7;
    lp.connect(out); out.connect(this.musicBus);
    out.connect(this.mVerb);
    const oscs = [];
    // [ratio to root ('c' = biome colour interval), wave, detune cents, level]
    [[0.5, 'sine', 3, 0.08], [1, 'sine', 0, 0.42], ['c', 'triangle', 6, 0.24], [2, 'sine', -5, 0.42], [3, 'sine', 4, 0.2]].forEach(([m, type, det, lv]) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = root * (m === 'c' ? col[0] : m); o.detune.value = det;
      const g = ctx.createGain(); g.gain.value = lv;
      o.connect(g); g.connect(lp); o.start(); oscs.push({ o, m });
    });
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.06;
    const lg = ctx.createGain(); lg.gain.value = 110;
    lfo.connect(lg); lg.connect(lp.frequency); lfo.start();
    // ocean rumble
    const ns = ctx.createBufferSource(); ns.buffer = this.noiseBuf; ns.loop = true;
    const nf = ctx.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = 340;
    const ng = ctx.createGain(); ng.gain.value = col[2];
    ns.connect(nf); nf.connect(ng); ng.connect(out); ns.start();
    const lfo2 = ctx.createOscillator(); lfo2.frequency.value = 0.11;
    const lg2 = ctx.createGain(); lg2.gain.value = 0.04;
    lfo2.connect(lg2); lg2.connect(ng.gain); lfo2.start();
    // currents: a slow band-limited swell in the mids, so the bed is present on small speakers too
    const nb = ctx.createBiquadFilter(); nb.type = 'bandpass'; nb.frequency.value = 520; nb.Q.value = 0.9;
    const ng2 = ctx.createGain(); ng2.gain.value = 0.6;
    ns.connect(nb); nb.connect(ng2); ng2.connect(out);
    const lfo3 = ctx.createOscillator(); lfo3.frequency.value = 0.043;
    const lg3 = ctx.createGain(); lg3.gain.value = 260;
    lfo3.connect(lg3); lg3.connect(nb.frequency); lfo3.start();
    const lfo4 = ctx.createOscillator(); lfo4.frequency.value = 0.071;
    const lg4 = ctx.createGain(); lg4.gain.value = 0.4;
    lfo4.connect(lg4); lg4.connect(ng2.gain); lfo4.start();
    this.drone = { out, lp, oscs, ng };
    this.bed(false);
  }

  // bed level follows the game state; automation is only touched when the target moves (no per-frame events)
  bed(playing) {
    const d = this.drone;
    if (!d) return;
    const target = (playing ? 0.06 : 0.085) + this.dg * 0.03;
    if (Math.abs(target - this.droneT) < 0.002) return;
    this.droneT = target;
    const t = this.now();
    d.out.gain.setTargetAtTime(target, t, 0.9);
    d.lp.frequency.setTargetAtTime(this.lpHz(), t, 0.9); // danger opens the filter: more edge in the drone
  }
  lpHz() { return COLOR[this.biome][1] + Math.min(this.depth, 12) * 4 + this.dg * 140; }

  setBiome(biomeId, depth) {
    const b = clamp(num(biomeId, 0) | 0, 0, ROOTS.length - 1);
    this.biome = b; this.depth = num(depth, this.depth);
    if (!this.ok || !this.drone) return;
    const t = this.now(), root = ROOTS[b], col = COLOR[b], d = this.drone;
    for (const { o, m } of d.oscs) o.frequency.setTargetAtTime(root * (m === 'c' ? col[0] : m), t, 1.5);
    d.lp.frequency.setTargetAtTime(this.lpHz(), t, 1.2);
    d.ng.gain.setTargetAtTime(col[2], t, 1.5);
  }

  setDanger(v) { this.danger = clamp(num(v, 0), 0, 1); this.dangerAge = 0; }

  // per-frame: bed level, music, heartbeat, whale song
  tick(dt, playing) {
    if (!this.live) return;
    dt = clamp(num(dt, 0.016), 0, 0.25);
    // the game reports danger every play frame; screens that stop reporting (level end, death) let the heartbeat die away
    this.dangerAge += dt;
    this.dg = this.dangerAge < 0.5 ? this.danger : this.danger * Math.max(0, 1 - (this.dangerAge - 0.5) / 1.2);
    this.bed(playing);
    if (this.chargeVoice && this.now() - this.chargeVoice.last > 2) this.chargeStop(); // the game forgot to release: never leave a whine hanging
    this.pearlT -= dt;
    if (this.pearlT <= 0) this.pearlStreak = 0;
    this.musicT -= dt;
    if (this.musicT <= 0) {
      const root = ROOTS[this.biome] * 4;
      const n = SCALE[(Math.random() * SCALE.length) | 0];
      const f = root * Math.pow(2, n / 12);
      const g = 0.055 * (1 + this.dg * 0.4);
      this.tone({ f, type: 'sine', a: 0.03, d: 2.6, gain: g, send: 0.95, dsend: 0.35, pan: rand(-0.6, 0.6), bus: 'music', lo: 1 });
      this.tone({ f: f * 2.003, type: 'triangle', a: 0.04, d: 1.4, gain: g * 0.28, send: 0.9, bus: 'music', lo: 1 });
      if (Math.random() < 0.28) this.tone({ f: f * 1.5, type: 'sine', t: 0.35, a: 0.03, d: 2.2, gain: g * 0.7, send: 0.95, dsend: 0.3, pan: rand(-0.6, 0.6), bus: 'music', lo: 1 });
      this.musicT = rand(2.0, 5.4) * (1 - this.dg * 0.5);
    }
    if (playing && this.depth >= 2) {
      this.whaleT -= dt;
      if (this.whaleT <= 0) { this.whale(); this.whaleT = rand(32, 70); }
    }
    if (playing && this.dg > 0.08) {
      this.beatT -= dt;
      if (this.beatT <= 0) {
        const bpm = 62 + this.dg * 90, per = 60 / bpm;
        this.beatT = per;
        const g = 0.065 + this.dg * 0.11, gap = Math.min(0.17, per * 0.4);
        this.tone({ f: 110, f2: 52, type: 'sine', a: 0.004, d: 0.17, gain: g, lp: 300 });
        this.noise({ type: 'lowpass', f: 320, f2: 100, d: 0.1, a: 0.003, gain: g * 0.45 });
        this.tone({ f: 96, f2: 48, type: 'sine', t: gap, a: 0.004, d: 0.14, gain: g * 0.7, lp: 280 });
      }
    }
  }

  whale() {
    if (!this.live) return;
    const deep = this.depth >= 10; // the trench sings lower and longer
    const base = rand(120, 190) * (deep ? 0.66 : 1);
    const pan = rand(-0.8, 0.8);
    const o = this.tone({ f: base, type: 'sine', a: 0.8, d: 3.6, gain: 0.075, pan, send: 1, dsend: 0.2, glide: 3.4, f2: base * rand(1.25, 1.7), bus: 'music', lo: 1 });
    this.tone({ f: base * 2.01, type: 'sine', a: 1.0, d: 3.2, gain: 0.028, pan, send: 1, glide: 3.4, f2: base * 2.6, bus: 'music', lo: 1 });
    if (o) {
      // slow vibrato (cleaned up with its voice)
      const keep = [];
      try {
        const lfo = this.ctx.createOscillator(); keep.push(lfo); lfo.frequency.value = rand(4.4, 5.6);
        const lg = this.ctx.createGain(); keep.push(lg); lg.gain.value = 9;
        lfo.connect(lg); lg.connect(o.detune);
        lfo.start(); lfo.stop(this.now() + 4.8);
        lfo.onended = () => { try { keep.forEach((n) => n.disconnect()); } catch (e) { /* noop */ } };
      } catch (e) { this.fail(e, keep); }
    }
  }

  /* ---------- player sounds ---------- */
  chargeStart() {
    if (!this.live || this.chargeVoice) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 200;
    const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = 400;
    const g = ctx.createGain(); g.gain.value = 0.0001;
    const g2 = ctx.createGain(); g2.gain.value = 0.3;
    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(this.sfx);
    const s = ctx.createGain(); s.gain.value = 0.5; g.connect(s); s.connect(this.verbSend);
    o.start(); o2.start();
    this.chargeVoice = { o, o2, g, s, g2, last: this.now() };
  }
  chargeUpdate(level) {
    const v = this.chargeVoice;
    if (!v) return;
    level = clamp(num(level, 0), 0, 1);
    const t = this.now();
    v.last = t;
    v.o.frequency.setTargetAtTime(190 + level * 560, t, 0.04);
    v.o2.frequency.setTargetAtTime(380 + level * 1120, t, 0.04);
    v.g.gain.setTargetAtTime(0.02 + level * 0.05, t, 0.05);
  }
  chargeStop() {
    const v = this.chargeVoice;
    if (!v) return;
    this.chargeVoice = null;
    const t = this.now();
    v.g.gain.cancelScheduledValues(t);
    v.g.gain.setTargetAtTime(0.0001, t, 0.03);
    setTimeout(() => { try { v.o.stop(); v.o2.stop(); v.o.disconnect(); v.o2.disconnect(); v.g.disconnect(); v.g2.disconnect(); v.s.disconnect(); } catch (e) { /* noop */ } }, 260);
  }

  ping(power = 0, o) {
    if (!this.live) return;
    o = o || {};
    power = clamp(num(power, 0), 0, 1);
    const k = num(o.gain, 1);
    const f0 = 1900 - 800 * power;
    const g = k * (0.13 + 0.12 * power);
    this.tone({ f: f0, f2: f0 * 0.93, type: 'sine', a: 0.004, d: 0.55 + power * 0.9, gain: g, pan: o.pan, send: 0.85, dsend: 0.55 });
    this.tone({ f: f0 * 2.01, f2: f0 * 1.9, type: 'sine', a: 0.003, d: 0.25 + power * 0.3, gain: g * 0.28, pan: o.pan, send: 0.7, dsend: 0.3 });
    if (power > 0.15) this.tone({ f: 96 - power * 30, f2: 38, type: 'sine', a: 0.005, d: 0.4 + power * 0.4, gain: power * 0.32 * k, lp: 200 });
  }

  // returning sonar: a rain of ticks, brighter and louder for near/strong returns, with a scale-tuned chime on the strongest few
  echoes(list) {
    if (!this.live || !list || !(list.length > 0)) return;
    const n = Math.min(list.length, 11), root = ROOTS[this.biome] * 8;
    for (let i = 0; i < n; i++) {
      const e = list[i];
      if (!e) continue;
      const eg = clamp(num(e.gain, 0), 0, 1), et = Math.max(0, num(e.t, 0)), ep = clamp(num(e.pan, 0) * 0.9, -1, 1);
      const f = rand(2000, 4200) * (1 - 0.25 * Math.min(1, et / 1.4)); // far echoes are darker
      this.noise({ t: et + 0.015, f, q: 4, d: 0.1, a: 0.002, gain: 0.56 * eg, pan: ep, send: 0.7 });
      if (i < 5) {
        const fn = root * Math.pow(2, SCALE[(Math.random() * SCALE.length) | 0] / 12);
        this.tone({ f: fn, f2: fn * 0.8, t: et + 0.02, d: 0.18, a: 0.003, gain: 0.11 * eg, pan: ep, send: 0.8 });
      }
    }
  }

  pickup(kind) {
    if (!this.live) return;
    if (kind === 'pearl') {
      this.pearlStreak = Math.min(this.pearlStreak + 1, PEARL_SCALE.length - 1);
      this.pearlT = 2.2;
      const f = 523.25 * Math.pow(2, PEARL_SCALE[this.pearlStreak - 1] / 12);
      this.bell(f, { gain: 0.16, d: 1.1 });
      this.bell(f * 1.5, { gain: 0.075, d: 0.9, t: 0.07 });
    } else if (kind === 'buoy') {
      this.bell(392, { gain: 0.105 }); this.bell(587.33, { gain: 0.105, t: 0.09 }); this.bell(783.99, { gain: 0.095, t: 0.18 });
    } else if (kind === 'patch') {
      [261.63, 329.63, 392, 523.25].forEach((f, i) => this.bell(f, { gain: 0.1, t: i * 0.08, d: 1.8 }));
    }
  }

  hit() {
    if (!this.live) return;
    this.noise({ type: 'lowpass', f: 3200, f2: 200, d: 0.4, a: 0.003, gain: 0.8, send: 0.4 });
    this.noise({ type: 'bandpass', f: 2400, f2: 600, q: 0.6, d: 0.25, a: 0.003, gain: 1.15, send: 0.3 }); // the crack that small speakers can reproduce
    this.tone({ f: 200, f2: 48, d: 0.55, a: 0.003, gain: 0.56, lp: 650 });
    this.tone({ f: 311, f2: 293, type: 'sawtooth', d: 0.7, a: 0.004, gain: 0.38, lp: 2200, lp2: 300, send: 0.5 });
    this.tone({ f: 466, f2: 440, type: 'square', d: 0.3, a: 0.004, gain: 0.14, lp: 2400, lp2: 350, send: 0.4 }); // dissonant crack
  }
  dash() {
    if (!this.live) return;
    this.noise({ type: 'bandpass', f: 380, f2: 2200, q: 1.2, d: 0.34, a: 0.03, gain: 0.32, send: 0.25 });
    this.tone({ f: 140, f2: 320, d: 0.25, a: 0.01, gain: 0.07, lp: 800 });
  }
  buoyPlace() {
    if (!this.live) return;
    this.tone({ f: 520, f2: 190, d: 0.18, a: 0.004, gain: 0.15, send: 0.4 });
    this.noise({ f: 1800, q: 2, d: 0.12, gain: 0.11, send: 0.3 });
  }
  buoyBeep(pan = 0, gain = 1) {
    if (!this.live) return;
    this.tone({ f: 740, f2: 700, d: 0.28, a: 0.004, gain: 0.1 * gain, pan, send: 0.7, dsend: 0.5 });
  }
  denied() {
    if (!this.live) return;
    this.tone({ f: 330, f2: 230, type: 'square', d: 0.14, a: 0.003, gain: 0.07, lp: 1000 });
  }

  /* ---------- creature sounds (spatialised by the caller) ---------- */
  click(pan = 0, gain = 1) { if (this.live) this.tone({ f: 2700, f2: 2200, d: 0.04, a: 0.001, gain: 0.2 * gain, pan, send: 0.4 }); }
  alert(pan = 0, gain = 1) {
    if (!this.live) return;
    this.tone({ f: 120, f2: 230, type: 'sawtooth', d: 0.55, a: 0.04, gain: 0.68 * gain, lp: 900, lp2: 2400, pan, send: 0.5 });
    this.tone({ f: 1100, f2: 2300, d: 0.22, a: 0.005, gain: 0.34 * gain, pan, send: 0.5 });
    this.noise({ type: 'bandpass', f: 1500, f2: 3000, q: 1.5, d: 0.25, a: 0.01, gain: 0.47 * gain, pan, send: 0.4 }); // warning hiss
  }
  alert2(pan = 0, gain = 1) { if (this.live) this.tone({ f: 700, f2: 380, d: 0.3, a: 0.01, gain: 0.1 * gain, pan, send: 0.6 }); }
  lunge(pan = 0, gain = 1) {
    if (!this.live) return;
    this.tone({ f: 200, f2: 55, type: 'sawtooth', d: 0.6, a: 0.01, gain: 0.54 * gain, lp: 1800, lp2: 180, pan, send: 0.4 });
    this.noise({ type: 'bandpass', f: 900, f2: 250, q: 0.8, d: 0.45, gain: 0.8 * gain, pan });
  }
  roar(pan = 0, gain = 1) {
    if (!this.live) return;
    this.tone({ f: 58, f2: 38, type: 'sawtooth', d: 2.2, a: 0.15, gain: 0.4 * gain, lp: 260, lp2: 110, pan, send: 0.8 });
    this.tone({ f: 116, f2: 74, type: 'sawtooth', d: 2.0, a: 0.2, gain: 0.4 * gain, lp: 1000, lp2: 380, pan, send: 0.8 });
    this.tone({ f: 232, f2: 148, type: 'sawtooth', d: 1.8, a: 0.2, gain: 0.32 * gain, lp: 1800, lp2: 700, pan, send: 0.8 });
    this.tone({ f: 348, f2: 224, type: 'sawtooth', d: 1.4, a: 0.3, gain: 0.12 * gain, lp: 1800, lp2: 800, pan, send: 0.8 });
    this.noise({ type: 'bandpass', f: 700, f2: 180, q: 0.7, d: 1.8, a: 0.1, gain: 0.9 * gain, pan, send: 0.6 });
  }
  thrum(pan = 0, gain = 1) {
    if (!this.live) return;
    this.tone({ f: 66, f2: 52, d: 0.5, a: 0.04, gain: 0.24 * gain, lp: 220, pan, send: 0.5 });
    this.tone({ f: 132, f2: 104, d: 0.4, a: 0.04, gain: 0.13 * gain, lp: 420, pan, send: 0.5 });
    this.tone({ f: 264, f2: 208, d: 0.3, a: 0.03, gain: 0.12 * gain, pan, send: 0.5 }); // the part small speakers can reproduce
    this.noise({ type: 'bandpass', f: 600, f2: 220, q: 1, d: 0.14, a: 0.01, gain: 0.3 * gain, pan, send: 0.4 });
  }

  /* ---------- fanfares & UI ---------- */
  levelComplete() {
    if (!this.live) return;
    [293.66, 369.99, 440, 587.33, 739.99].forEach((f, i) => this.bell(f, { t: i * 0.11, gain: 0.12, d: 2.2, send: 0.9 }));
    this.tone({ f: 73.4, d: 2.4, a: 0.3, gain: 0.2, lp: 200, send: 0.5 });
  }
  gameOver() {
    if (!this.live) return;
    this.tone({ f: 220, f2: 28, type: 'sawtooth', d: 3.2, a: 0.02, gain: 0.32, lp: 900, lp2: 70, send: 0.8 });
    this.noise({ type: 'lowpass', f: 1400, f2: 60, d: 2.8, a: 0.02, gain: 0.3, send: 0.7 });
    this.tone({ f: 55, d: 4, a: 0.5, gain: 0.3, lp: 120 });
  }
  victory() {
    if (!this.live) return;
    [261.63, 329.63, 392, 523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.bell(f, { t: i * 0.14, gain: 0.12, d: 3.6, send: 1 }));
    this.tone({ f: 65.4, d: 5, a: 0.6, gain: 0.25, lp: 220, send: 0.6 });
  }
  newDepth() {
    if (!this.live) return;
    this.tone({ f: 65, f2: 98, d: 2.2, a: 0.5, gain: 0.17, lp: 240, send: 0.8 });
    this.bell(ROOTS[this.biome] * 8, { gain: 0.065, d: 2.4, t: 0.4 });
  }
  ui(kind) {
    if (!this.live) return;
    if (kind === 'hover') this.tone({ f: 920, d: 0.05, a: 0.002, gain: 0.06, send: 0.2 });
    else if (kind === 'back') this.tone({ f: 520, f2: 330, d: 0.1, a: 0.003, gain: 0.1, send: 0.3 });
    else if (kind === 'upgrade') { this.bell(659.25, { gain: 0.1 }); this.bell(987.77, { gain: 0.08, t: 0.08 }); }
    else this.tone({ f: 560, f2: 880, d: 0.11, a: 0.003, gain: 0.11, send: 0.35 });
  }

  // 0..1 current output level (for diagnostics/tests)
  peak() {
    if (!this.ok) return 0;
    const buf = this.peakBuf || (this.peakBuf = new Float32Array(this.analyser.fftSize));
    this.analyser.getFloatTimeDomainData(buf);
    let m = 0;
    for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]));
    return m;
  }
}
