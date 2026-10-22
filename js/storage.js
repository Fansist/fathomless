// localStorage wrapper that never throws (private windows, blocked storage, etc).
const PREFIX = 'fathomless.';
const mem = {};

// a stored value of the wrong shape (hand-edited / corrupted JSON such as "null" or "5") falls back to the default
const sane = (v, def) => def === null || def === undefined || (v !== null && typeof v === typeof def && Array.isArray(v) === Array.isArray(def));

export function load(key, def) {
  let v;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    v = raw === null ? (key in mem ? mem[key] : def) : JSON.parse(raw);
  } catch (e) {
    v = key in mem ? mem[key] : def;
  }
  return sane(v, def) ? v : def;
}

export function save(key, val) {
  mem[key] = val;
  try { window.localStorage.setItem(PREFIX + key, JSON.stringify(val)); } catch (e) { /* ignore */ }
}
