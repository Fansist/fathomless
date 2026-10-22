// Fully synthesized soundscape (Web Audio). No samples, no assets.
// Every method is a safe no-op until init() succeeds, so the game never depends on audio.

const ROOTS = [55.0, 49.0, 46.25, 41.2];          // A1, G1, F#1, E1 per biome
const SCALE = [0, 3, 5, 7, 10, 12, 15, 17, 19];   // minor pentatonic-ish
const PEARL_SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ok = false;
    this.volume = 0.8;
    this.musicVol = 0.7;
    this.muted = false;
    this.voices = 0;
    this.biome = 0;
    this.depth = 1;
    this.danger = 0;
    this.musicT = 2;
    this.whaleT = rand(25, 45);
    this.beatT = 0;
    this.pearlStreak = 0;
    this.pearlT = 0;
    this.chargeVoice = null;
    this.drone = null;
  }

  /* ---------- lifecycle ---------- */
  init() {
    if (this.ctx) { this.resume(); return this.ok; }
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return false;
    try {
      const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -16; this.comp.knee.value = 14; this.comp.ratio.value = 5;
      this.comp.attack.value = 0.004; this.comp.release.value = 0.25;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.master.connect(this.comp);
      this.comp.connect(ctx.destination);
      this.comp.connect(this.analyser);

      this.sfx = ctx.createGain(); this.sfx.gain.value = 1; this.sfx.connect(this.master);
      this.musicBus = ctx.createGain(); this.musicBus.gain.value = this.musicVol; this.musicBus.connect(this.master);

      // cave reverb
      this.verb = ctx.createConvolver();
      this.verb.buffer = this.makeImpulse(3.6, 2.2);
      this.verbSend = ctx.createGain(); this.verbSend.gain.value = 1;
      this.verbOut = ctx.createGain(); this.verbOut.gain.value = 0.7;
      this.verbSend.connect(this.verb); this.verb.connect(this.verbOut); this.verbOut.connect(this.master);

      // ping echo (dark feedback delay feeding the reverb)
      this.delay = ctx.createDelay(1.5); this.delay.delayTime.value = 0.34;
      this.fb = ctx.createGain(); this.fb.gain.value = 0.38;
      this.dlp = ctx.createBiquadFilter(); this.dlp.type = 'lowpass'; this.dlp.frequency.value = 1700;
      this.delaySend = ctx.createGain(); this.delaySend.gain.value = 1;
      this.delaySend.connect(this.delay); this.delay.connect(this.dlp);
      this.dlp.connect(this.fb); this.fb.connect(this.delay);
      this.dlp.connect(this.verbSend);
      const dOut = ctx.createGain(); dOut.gain.value = 0.55; this.dlp.connect(dOut); dOut.connect(this.master);

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
      this.resume();
    } catch (err) {
      console.warn('audio unavailable', err);
      this.ok = false;
    }
    return this.ok;
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }
  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {}); }

  setVolumes(master, music) {
    if (master !== undefined) this.volume = clamp(master, 0, 1);
    if (music !== undefined) this.musicVol = clamp(music, 0, 1);
    if (!this.ok) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.musicVol, t, 0.1);
  }
  setMuted(m) { this.muted = !!m; this.setVolumes(); }

  makeImpulse(dur, decay) {
    const ctx = this.ctx, rate = ctx.sampleRate, len = (rate * dur) | 0;
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        lp += ((Math.random() * 2 - 1) - lp) * (0.62 - 0.55 * t); // gets darker as it decays
        data[i] = lp * Math.pow(1 - t, decay) * (i < 200 ? i / 200 : 1);
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
    if (pan && ctx.createStereoPanner) {
      panner = ctx.createStereoPanner(); panner.pan.value = clamp(pan, -1, 1);
      out.connect(panner); out = panner;
    }
    out.connect(bus === 'music' ? this.musicBus : this.sfx);
    const nodes = [panner];
    if (send > 0) { const s = ctx.createGain(); s.gain.value = send; out.connect(s); s.connect(this.verbSend); nodes.push(s); }
    if (dsend > 0) { const s = ctx.createGain(); s.gain.value = dsend; out.connect(s); s.connect(this.delaySend); nodes.push(s); }
    return nodes.filter(Boolean);
  }

  // one oscillator voice with an AD envelope
  tone(o) {
    if (!this.ok || this.voices > 70) return null;
    const ctx = this.ctx;
    const t0 = this.now() + (o.t || 0);
    const a = o.a ?? 0.005, d = o.d ?? 0.3, peak = o.gain ?? 0.2;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t0);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f2), t0 + (o.glide ?? a + d));
    if (o.detune) osc.detune.value = o.detune;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
    let src = osc;
    const extra = [];
    if (o.lp) {
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(o.lp, t0);
      if (o.lp2) f.frequency.exponentialRampToValueAtTime(o.lp2, t0 + a + d);
      osc.connect(f); f.connect(g); extra.push(f);
    } else osc.connect(g);
    const nodes = this.route(g, o);
    this.voices++;
    osc.start(t0);
    osc.stop(t0 + a + d + 0.08);
    osc.onended = () => {
      this.voices--;
      try { osc.disconnect(); g.disconnect(); extra.forEach((n) => n.disconnect()); nodes.forEach((n) => n.disconnect()); } catch (e) { /* noop */ }
    };
    return osc;
  }

  // filtered noise burst
  noise(o) {
    if (!this.ok || this.voices > 70) return null;
    const ctx = this.ctx;
    const t0 = this.now() + (o.t || 0);
    const a = o.a ?? 0.004, d = o.d ?? 0.2;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(o.f || 1000, t0);
    if (o.f2) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t0 + a + d);
    f.Q.value = o.q ?? 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(o.gain ?? 0.2, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
    src.connect(f); f.connect(g);
    const nodes = this.route(g, o);
    this.voices++;
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + a + d + 0.08);
    src.onended = () => {
      this.voices--;
      try { src.disconnect(); f.disconnect(); g.disconnect(); nodes.forEach((n) => n.disconnect()); } catch (e) { /* noop */ }
    };
    return src;
  }

  bell(f, o = {}) {
    const t = o.t || 0, g = o.gain ?? 0.12, d = o.d ?? 1.4;
    this.tone({ f, type: 'sine', t, a: 0.004, d, gain: g, pan: o.pan, send: o.send ?? 0.7, dsend: o.dsend ?? 0.15, bus: o.bus });
    this.tone({ f: f * 2.756, type: 'sine', t, a: 0.003, d: d * 0.35, gain: g * 0.32, pan: o.pan, send: o.send ?? 0.7, bus: o.bus });
    this.tone({ f: f * 5.4, type: 'sine', t, a: 0.002, d: d * 0.12, gain: g * 0.12, pan: o.pan, send: o.send ?? 0.7, bus: o.bus });
  }

  /* ---------- ambience ---------- */
  startDrone() {
    const ctx = this.ctx;
    const root = ROOTS[this.biome];
    const out = ctx.createGain(); out.gain.value = 0;
    out.gain.linearRampToValueAtTime(0.22, ctx.currentTime + 4);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260; lp.Q.value = 0.7;
    lp.connect(out); out.connect(this.musicBus);
    out.connect(this.verbSend);
    const oscs = [];
    [[1, 'sine', 0], [1.5, 'triangle', 6], [2, 'sine', -5], [0.5, 'sine', 3]].forEach(([m, type, det], i) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = root * m; o.detune.value = det;
      const g = ctx.createGain(); g.gain.value = i === 0 ? 0.5 : i === 3 ? 0.6 : 0.22;
      o.connect(g); g.connect(lp); o.start(); oscs.push({ o, m });
    });
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.06;
    const lg = ctx.createGain(); lg.gain.value = 120;
    lfo.connect(lg); lg.connect(lp.frequency); lfo.start();
    // ocean rumble
    const ns = ctx.createBufferSource(); ns.buffer = this.noiseBuf; ns.loop = true;
    const nf = ctx.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = 340;
    const ng = ctx.createGain(); ng.gain.value = 0.09;
    ns.connect(nf); nf.connect(ng); ng.connect(out); ns.start();
    const lfo2 = ctx.createOscillator(); lfo2.frequency.value = 0.11;
    const lg2 = ctx.createGain(); lg2.gain.value = 0.04;
    lfo2.connect(lg2); lg2.connect(ng.gain); lfo2.start();
    this.drone = { out, lp, oscs };
  }

  setBiome(biomeId, depth) {
    this.biome = biomeId; this.depth = depth;
    if (!this.ok || !this.drone) return;
    const t = this.now(), root = ROOTS[biomeId];
    for (const { o, m } of this.drone.oscs) o.frequency.setTargetAtTime(root * m, t, 1.5);
    this.drone.lp.frequency.setTargetAtTime(220 + biomeId * 40, t, 1);
  }

  setDanger(v) { this.danger = clamp(v, 0, 1); }

  // per-frame: music, heartbeat, whale song
  tick(dt, playing) {
    if (!this.ok || this.ctx.state !== 'running') return;
    if (this.drone) {
      const target = (playing ? 0.22 : 0.3) + this.danger * 0.12;
      this.drone.out.gain.setTargetAtTime(target, this.now(), 0.8);
    }
    this.pearlT -= dt;
    if (this.pearlT <= 0) this.pearlStreak = 0;
    this.musicT -= dt;
    if (this.musicT <= 0) {
      const root = ROOTS[this.biome] * 4;
      const n = SCALE[(Math.random() * SCALE.length) | 0];
      const f = root * Math.pow(2, n / 12);
      const g = 0.055 * (1 + this.danger * 0.4);
      this.tone({ f, type: 'sine', a: 0.03, d: 2.6, gain: g, send: 0.95, dsend: 0.35, pan: rand(-0.6, 0.6), bus: 'music' });
      this.tone({ f: f * 2.003, type: 'triangle', a: 0.04, d: 1.4, gain: g * 0.28, send: 0.9, bus: 'music' });
      if (Math.random() < 0.28) this.tone({ f: f * 1.5, type: 'sine', t: 0.35, a: 0.03, d: 2.2, gain: g * 0.7, send: 0.95, dsend: 0.3, pan: rand(-0.6, 0.6), bus: 'music' });
      this.musicT = rand(2.0, 5.4) * (1 - this.danger * 0.5);
    }
    if (playing && this.depth >= 2) {
      this.whaleT -= dt;
      if (this.whaleT <= 0) { this.whale(); this.whaleT = rand(32, 70); }
    }
    if (playing && this.danger > 0.08) {
      this.beatT -= dt;
      if (this.beatT <= 0) {
        const bpm = 62 + this.danger * 90;
        this.beatT = 60 / bpm;
        const g = 0.18 + this.danger * 0.5;
        this.tone({ f: 70, f2: 38, type: 'sine', a: 0.004, d: 0.17, gain: g, lp: 160 });
        this.tone({ f: 62, f2: 34, type: 'sine', t: 0.17, a: 0.004, d: 0.15, gain: g * 0.7, lp: 140 });
      }
    }
  }

  whale() {
    const base = rand(120, 190);
    const pan = rand(-0.8, 0.8);
    const o = this.tone({ f: base, type: 'sine', a: 0.8, d: 3.6, gain: 0.07, pan, send: 1, dsend: 0.2, glide: 3.4, f2: base * rand(1.25, 1.7), bus: 'music' });
    this.tone({ f: base * 2.01, type: 'sine', a: 1.0, d: 3.2, gain: 0.025, pan, send: 1, glide: 3.4, f2: base * 2.6, bus: 'music' });
    if (o) {
      // slow vibrato
      const lfo = this.ctx.createOscillator(); lfo.frequency.value = 5.2;
      const lg = this.ctx.createGain(); lg.gain.value = 4;
      lfo.connect(lg); lg.connect(o.detune);
      lfo.start(); lfo.stop(this.now() + 4.8);
    }
  }

  /* ---------- player sounds ---------- */
  chargeStart() {
    if (!this.ok || this.chargeVoice) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 200;
    const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = 400;
    const g = ctx.createGain(); g.gain.value = 0.0001;
    const g2 = ctx.createGain(); g2.gain.value = 0.3;
    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(this.sfx);
    const s = ctx.createGain(); s.gain.value = 0.5; g.connect(s); s.connect(this.verbSend);
    o.start(); o2.start();
    this.chargeVoice = { o, o2, g, s, g2 };
  }
  chargeUpdate(level) {
    const v = this.chargeVoice;
    if (!v) return;
    const t = this.now();
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

  ping(power = 0, o = {}) {
    if (!this.ok) return;
    const f0 = 1900 - 800 * power;
    const g = (o.gain ?? 1) * (0.2 + 0.1 * power);
    this.tone({ f: f0, f2: f0 * 0.93, type: 'sine', a: 0.004, d: 0.55 + power * 0.9, gain: g, pan: o.pan, send: 0.85, dsend: 0.55 });
    this.tone({ f: f0 * 2.01, f2: f0 * 1.9, type: 'sine', a: 0.003, d: 0.25 + power * 0.3, gain: g * 0.28, pan: o.pan, send: 0.7, dsend: 0.3 });
    if (power > 0.15) this.tone({ f: 96 - power * 30, f2: 38, type: 'sine', a: 0.005, d: 0.4 + power * 0.4, gain: power * 0.38 * (o.gain ?? 1), lp: 200 });
  }

  echoes(list) {
    if (!this.ok || !list) return;
    const n = Math.min(list.length, 11);
    for (let i = 0; i < n; i++) {
      const e = list[i];
      const f = rand(2000, 4200);
      this.noise({ t: e.t + 0.015, f, q: 7, d: 0.1, a: 0.002, gain: 0.1 * e.gain, pan: clamp(e.pan * 0.9, -1, 1), send: 0.7 });
      if (i < 5) this.tone({ f: rand(900, 1500), f2: 700, t: e.t + 0.02, d: 0.16, a: 0.003, gain: 0.03 * e.gain, pan: e.pan * 0.9, send: 0.8 });
    }
  }

  pickup(kind) {
    if (!this.ok) return;
    if (kind === 'pearl') {
      this.pearlStreak = Math.min(this.pearlStreak + 1, PEARL_SCALE.length - 1);
      this.pearlT = 2.2;
      const f = 523.25 * Math.pow(2, PEARL_SCALE[this.pearlStreak - 1] / 12);
      this.bell(f, { gain: 0.13, d: 1.1 });
      this.bell(f * 1.5, { gain: 0.06, d: 0.9, t: 0.07 });
    } else if (kind === 'buoy') {
      this.bell(392, { gain: 0.1 }); this.bell(587.33, { gain: 0.1, t: 0.09 }); this.bell(783.99, { gain: 0.09, t: 0.18 });
    } else if (kind === 'patch') {
      [261.63, 329.63, 392, 523.25].forEach((f, i) => this.bell(f, { gain: 0.1, t: i * 0.08, d: 1.8 }));
    }
  }

  hit() {
    if (!this.ok) return;
    this.noise({ type: 'lowpass', f: 900, f2: 120, d: 0.5, a: 0.002, gain: 0.5, send: 0.4 });
    this.tone({ f: 150, f2: 38, d: 0.6, a: 0.003, gain: 0.55, lp: 400 });
    this.tone({ f: 311, f2: 293, type: 'sawtooth', d: 0.7, a: 0.004, gain: 0.1, lp: 900, lp2: 200, send: 0.5 });
  }
  dash() {
    if (!this.ok) return;
    this.noise({ type: 'bandpass', f: 380, f2: 2200, q: 1.2, d: 0.34, a: 0.03, gain: 0.2, send: 0.25 });
    this.tone({ f: 140, f2: 320, d: 0.25, a: 0.01, gain: 0.08, lp: 600 });
  }
  buoyPlace() {
    if (!this.ok) return;
    this.tone({ f: 520, f2: 190, d: 0.18, a: 0.004, gain: 0.16, send: 0.4 });
    this.noise({ f: 1800, q: 2, d: 0.12, gain: 0.06, send: 0.3 });
  }
  buoyBeep(pan = 0, gain = 1) {
    if (!this.ok) return;
    this.tone({ f: 740, f2: 700, d: 0.28, a: 0.004, gain: 0.1 * gain, pan, send: 0.7, dsend: 0.5 });
  }
  denied() {
    if (!this.ok) return;
    this.tone({ f: 170, f2: 120, type: 'square', d: 0.14, a: 0.003, gain: 0.07, lp: 500 });
  }

  /* ---------- creature sounds (spatialised by the caller) ---------- */
  click(pan = 0, gain = 1) { if (this.ok) this.tone({ f: 2700, f2: 2200, d: 0.03, a: 0.001, gain: 0.07 * gain, pan, send: 0.4 }); }
  alert(pan = 0, gain = 1) {
    if (!this.ok) return;
    this.tone({ f: 88, f2: 168, type: 'sawtooth', d: 0.55, a: 0.04, gain: 0.2 * gain, lp: 420, lp2: 900, pan, send: 0.5 });
    this.tone({ f: 1400, f2: 2400, d: 0.2, a: 0.005, gain: 0.05 * gain, pan, send: 0.5 });
  }
  alert2(pan = 0, gain = 1) { if (this.ok) this.tone({ f: 640, f2: 380, d: 0.3, a: 0.01, gain: 0.05 * gain, pan, send: 0.6 }); }
  lunge(pan = 0, gain = 1) {
    if (!this.ok) return;
    this.tone({ f: 190, f2: 55, type: 'sawtooth', d: 0.6, a: 0.01, gain: 0.3 * gain, lp: 700, lp2: 150, pan, send: 0.4 });
    this.noise({ type: 'bandpass', f: 600, f2: 200, q: 1, d: 0.45, gain: 0.2 * gain, pan });
  }
  roar(pan = 0, gain = 1) {
    if (!this.ok) return;
    this.tone({ f: 58, f2: 38, type: 'sawtooth', d: 2.2, a: 0.15, gain: 0.4 * gain, lp: 260, lp2: 110, pan, send: 0.8 });
    this.tone({ f: 87, f2: 52, type: 'sawtooth', d: 1.8, a: 0.2, gain: 0.18 * gain, lp: 300, pan, send: 0.8 });
    this.noise({ type: 'lowpass', f: 400, f2: 80, d: 1.8, a: 0.1, gain: 0.25 * gain, pan, send: 0.6 });
  }
  thrum(pan = 0, gain = 1) { if (this.ok) this.tone({ f: 46, f2: 40, d: 0.5, a: 0.04, gain: 0.3 * gain, lp: 140, pan, send: 0.5 }); }

  /* ---------- fanfares & UI ---------- */
  levelComplete() {
    if (!this.ok) return;
    [293.66, 369.99, 440, 587.33, 739.99].forEach((f, i) => this.bell(f, { t: i * 0.11, gain: 0.12, d: 2.2, send: 0.9 }));
    this.tone({ f: 73.4, d: 2.4, a: 0.3, gain: 0.2, lp: 200, send: 0.5 });
  }
  gameOver() {
    if (!this.ok) return;
    this.tone({ f: 220, f2: 28, type: 'sawtooth', d: 3.2, a: 0.02, gain: 0.35, lp: 900, lp2: 70, send: 0.8 });
    this.noise({ type: 'lowpass', f: 1400, f2: 60, d: 2.8, a: 0.02, gain: 0.35, send: 0.7 });
    this.tone({ f: 55, d: 4, a: 0.5, gain: 0.3, lp: 120 });
  }
  victory() {
    if (!this.ok) return;
    [261.63, 329.63, 392, 523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.bell(f, { t: i * 0.14, gain: 0.12, d: 3.6, send: 1 }));
    this.tone({ f: 65.4, d: 5, a: 0.6, gain: 0.25, lp: 220, send: 0.6 });
  }
  newDepth() {
    if (!this.ok) return;
    this.tone({ f: 65, f2: 98, d: 2.2, a: 0.5, gain: 0.22, lp: 240, send: 0.8 });
    this.bell(ROOTS[this.biome] * 8, { gain: 0.08, d: 2.4, t: 0.4 });
  }
  ui(kind) {
    if (!this.ok) return;
    if (kind === 'hover') this.tone({ f: 920, d: 0.05, a: 0.002, gain: 0.035, send: 0.2 });
    else if (kind === 'back') this.tone({ f: 520, f2: 330, d: 0.1, a: 0.003, gain: 0.07, send: 0.3 });
    else if (kind === 'upgrade') { this.bell(659.25, { gain: 0.1 }); this.bell(987.77, { gain: 0.08, t: 0.08 }); }
    else this.tone({ f: 560, f2: 880, d: 0.11, a: 0.003, gain: 0.08, send: 0.35 });
  }

  // 0..1 current output level (for diagnostics/tests)
  peak() {
    if (!this.ok) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let m = 0;
    for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]));
    return m;
  }
}
