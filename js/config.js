// Tunables and static data. Pure, DOM-free.
import { clamp } from './rng.js';

export const CELL = 8;      // fine signed-distance-field cell (px)
export const COARSE = 16;   // generation / navigation cell (px)
export const MAX_DEPTH = 12;
export const DEPTH_METERS = 90; // flavour: metres per depth level

export const PLAYER = {
  r: 9,
  maxSpeed: 172,
  accelK: 5.0,      // velocity easing when thrusting
  dragK: 1.9,       // velocity easing when drifting
  dashSpeed: 400,
  dashTime: 0.28,
  hurtInvul: 1.8,
};

export const PING = {
  speed: 560,       // px/s wavefront speed
  minR: 230,
  maxR: 660,
  raysMin: 300,
  raysMax: 600,
  costMin: 9,
  costMax: 42,
  lifeAfter: 1.7,   // seconds an echo lingers after the wave dies
};

export const BIOMES = [
  { id: 0, name: 'Twilight Zone', tag: 'The last light fades above you.', from: 1, hue: 190, sat: 92 },
  { id: 1, name: 'Midnight Zone', tag: 'Nothing here has ever seen the sun.', from: 4, hue: 262, sat: 88 },
  { id: 2, name: 'Abyssal Plain', tag: 'The pressure sings in your hull.', from: 7, hue: 322, sat: 90 },
  { id: 3, name: 'Hadal Trench', tag: 'Something enormous is listening.', from: 10, hue: 138, sat: 85 },
];

export function biomeFor(depth) {
  let b = BIOMES[0];
  for (const x of BIOMES) if (depth >= x.from) b = x;
  return b;
}

export function levelSize(depth) {
  const d = Math.min(depth, MAX_DEPTH);
  if (d >= MAX_DEPTH) return { gw: 226, gh: 140 };
  return { gw: Math.min(122 + d * 8, 206), gh: Math.min(78 + d * 5, 128) };
}

export function spawnTable(depth) {
  const d = depth;
  return {
    jelly: clamp(Math.round(2 + d * 0.55), 2, 8),
    urchin: d >= 2 ? clamp(Math.round(d * 0.85), 1, 9) : 0,
    eel: d >= 3 ? clamp(Math.round((d - 1) * 0.42), 1, 5) : 0,
    angler: d >= 5 ? clamp(Math.round((d - 3) * 0.4), 1, 4) : 0,
    leviathan: d >= MAX_DEPTH ? 1 : 0,
    pearls: Math.round(9 + d * 1.3),
    buoys: d >= 8 ? 3 : 2,
    patches: d >= 2 ? (d >= MAX_DEPTH ? 2 : 1) : 0,
  };
}

export const UPGRADES = [
  { id: 'lens',      name: 'Resonant Lens',  max: 3, desc: 'Your pings reach 20% farther.' },
  { id: 'cell',      name: 'Deep Cell',      max: 3, desc: '+25 max energy and faster recharge.' },
  { id: 'hull',      name: 'Pressure Hull',  max: 3, desc: '+1 max hull and repair 1.' },
  { id: 'decoy',     name: 'Decoy Lab',      max: 3, desc: '+2 decoy buoys now. Decoys last longer.' },
  { id: 'fins',      name: 'Muffled Fins',   max: 2, desc: 'Swimming and pings carry less far to hunters.' },
  { id: 'memory',    name: 'Echo Memory',    max: 2, desc: 'Mapped walls glow brighter and ghost images linger far longer.' },
  { id: 'dowse',     name: 'Pearl Sense',    max: 2, desc: 'Pearls glint from afar and drift toward you.' },
  { id: 'burst',     name: 'Burst Fins',     max: 2, desc: 'Dashing costs less and recharges sooner.' },
  { id: 'capacitor', name: 'Quick Charge',   max: 2, desc: 'Charged pings build up 25% faster.' },
];

export function computeStats(ups = {}) {
  const u = (id) => ups[id] || 0;
  return {
    maxHull: 3 + u('hull'),
    maxEnergy: 100 + u('cell') * 25,
    regen: 7 + u('cell') * 1.6,
    rangeMult: 1 + u('lens') * 0.2,
    chargeTime: 0.95 * Math.pow(0.75, u('capacitor')),
    buoyLife: 7 + u('decoy') * 2.5,
    moveNoise: Math.pow(0.55, u('fins')),
    pingLoud: Math.pow(0.85, u('fins')),
    memory: 1 + u('memory') * 1.6,
    ghostLife: 1 + u('memory') * 0.7,
    dowse: u('dowse'),
    dashCost: 20 * Math.pow(0.7, u('burst')),
    dashCd: 1.5 * Math.pow(0.75, u('burst')),
  };
}

export function pickUpgrades(rng, ups, n = 3) {
  const pool = UPGRADES.filter((x) => (ups[x.id] || 0) < x.max);
  rng.shuffle(pool);
  return pool.slice(0, n);
}
