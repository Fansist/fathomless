// Keyboard, mouse and gamepad -> a small set of actions.
const ACTIONS = {
  dash: ['ShiftLeft', 'ShiftRight'],
  buoy: ['KeyE', 'KeyQ'],
  pause: ['Escape', 'KeyP'],
  mute: ['KeyM'],
  fullscreen: ['KeyF'],
  sel1: ['Digit1', 'Numpad1'],
  sel2: ['Digit2', 'Numpad2'],
  sel3: ['Digit3', 'Numpad3'],
  confirm: ['Enter'],
};
const BLOCK = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

export class Input {
  constructor(target) {
    this.keys = new Set();
    this.edges = new Set();
    this.mouseLeft = false;
    this.moveX = 0; this.moveY = 0;
    this.pingHeld = false;
    this.padPing = false;
    this.padPrev = {};
    this.usingPad = false;

    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (BLOCK.has(e.code) && !(e.target && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName) && e.code === 'Space')) e.preventDefault();
      if (!e.repeat) this.edges.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); });
    window.addEventListener('blur', () => this.reset());
    target.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.mouseLeft = true;
      if (e.button === 2) this.edges.add('MouseRight');
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.mouseLeft = false; });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  reset() { this.keys.clear(); this.edges.clear(); this.mouseLeft = false; }

  poll() {
    const k = this.keys;
    let x = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let y = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
    let ping = k.has('Space') || this.mouseLeft;
    this.padPing = false;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = pads && Array.from(pads).find((p) => p && p.connected);
    if (pad) {
      const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
      if (Math.hypot(ax, ay) > 0.22) { x += ax; y += ay; this.usingPad = true; }
      const b = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
      if (b(0) || b(7)) { ping = true; this.padPing = true; }
      const edge = (name, i) => { const now = b(i); if (now && !this.padPrev[name]) this.edges.add(name); this.padPrev[name] = now; };
      edge('PadDash', 1); edge('PadDash2', 5); edge('PadBuoy', 2); edge('PadPause', 9);
    }
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    this.moveX = x; this.moveY = y;
    this.pingHeld = ping;
  }

  // true once per press
  pressed(action) {
    const codes = ACTIONS[action] || [];
    for (const c of codes) if (this.edges.has(c)) { this.edges.delete(c); return true; }
    if (action === 'dash' && (this.edges.delete('PadDash') || this.edges.delete('PadDash2'))) return true;
    if (action === 'buoy' && (this.edges.delete('MouseRight') || this.edges.delete('PadBuoy'))) return true;
    if (action === 'pause' && this.edges.delete('PadPause')) return true;
    return false;
  }

  endFrame() { this.edges.clear(); }
}
