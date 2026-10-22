// Steady-state transfer curve of the master DynamicsCompressor for candidate settings (peak in -> peak out, dB).
// usage: node tools/audio-comp.mjs "thr,knee,ratio" "thr,knee,ratio" ...
import { openPage } from './audio-lib.mjs';
const sets = process.argv.slice(2).map((s) => s.split(',').map(Number));
const h = await openPage();
const r = await h.page.evaluate(async (sets) => {
  const out = [];
  const amps = [0.01, 0.03, 0.06, 0.1, 0.17, 0.3, 0.5, 0.8, 1.2];
  for (const [thr, knee, ratio] of sets) {
    const row = { set: [thr, knee, ratio].join('/'), gain: [] };
    for (const amp of amps) {
      const off = new OfflineAudioContext(1, 24000, 48000);
      const o = off.createOscillator(); o.frequency.value = 600; const g = off.createGain(); g.gain.value = amp;
      const c = off.createDynamicsCompressor(); c.threshold.value = thr; c.knee.value = knee; c.ratio.value = ratio; c.attack.value = 0.003; c.release.value = 0.25;
      o.connect(g); g.connect(c); c.connect(off.destination); o.start(0.05);
      const b = await off.startRendering(); const L = b.getChannelData(0); let pk = 0; for (let i = 12000; i < 24000; i++) pk = Math.max(pk, Math.abs(L[i]));
      row.gain.push(+(20 * Math.log10(pk / amp)).toFixed(1));
    }
    out.push(row);
  }
  return { amps, out };
}, sets);
console.log('input peak :', r.amps.join('  '));
for (const row of r.out) console.log(row.set.padEnd(10), 'gain dB:', row.gain.join('  '));
await h.close();
process.exit(0);
