// localStorage wrapper that never throws (private windows, blocked storage, etc).
const PREFIX = 'fathomless.';
const mem = {};

export function load(key, def) {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === null) return key in mem ? mem[key] : def;
    return JSON.parse(raw);
  } catch (e) {
    return key in mem ? mem[key] : def;
  }
}

export function save(key, val) {
  mem[key] = val;
  try { window.localStorage.setItem(PREFIX + key, JSON.stringify(val)); } catch (e) { /* ignore */ }
}
