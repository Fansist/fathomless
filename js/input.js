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
  confirm: ['Enter', 'NumpadEnter'],
};
const BLOCK = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);
const FORM = /^(INPUT|SELECT|TEXTAREA|BUTTON)$/;
// gamepad buttons that act as one-shot edges: [edge name, button index]
const PAD_EDGES = [['PadDash', 1], ['PadDash2', 5], ['PadBuoy', 2], ['PadPause', 9], ['PadOk', 0], ['PadUp', 12], ['PadDown', 13], ['PadLeft', 14], ['PadRight', 15]];

export class Input {
  constructor(target) {
    this.keys = new Set();
    this.edges = new Set();
    this.mouseLeft = false;
    this.tap = false;       // a ping press+release that fits between two frames still counts for one step
    this.moveX = 0; this.moveY = 0;
    this.pingHeld = false;
    this.padPing = false;
    this.padPrev = {};
    this.usingPad = false;
    this.stick = { x: 0, y: 0 };

    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (BLOCK.has(e.code)) {
        // Tab is only swallowed while swimming (menus need it); Space belongs to a focused form control; arrows to a focused slider
        const t = e.target, inForm = !!(t && t.tagName && FORM.test(t.tagName));
        const free = e.code === 'Tab' ? !document.body.classList.contains('playing') : e.code === 'Space' ? inForm : inForm && t.tagName !== 'BUTTON';
        if (!free) e.preventDefault();
      }
      if (!e.repeat) { this.edges.add(e.code); if (e.code === 'Space') this.tap = true; }
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); });
    window.addEventListener('blur', () => this.reset());
    target.addEventListener('mousedown', (e) => {
      if (e.button === 0) { this.mouseLeft = true; this.tap = true; }
      if (e.button === 2) this.edges.add('MouseRight');
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.mouseLeft = false; });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  reset() { this.keys.clear(); this.edges.clear(); this.mouseLeft = false; this.tap = false; }

  poll() {
    const k = this.keys;
    let x = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let y = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
    let ping = k.has('Space') || this.mouseLeft || this.tap;
    this.padPing = false;
    let pad = null;
    try {
      const pads = navigator.getGamepads ? navigator.getGamepads() : null;
      pad = pads && Array.from(pads).find((p) => p && p.connected);
    } catch (e) { pad = null; }
    if (pad) {
      const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
      const b = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
      if (Math.hypot(ax, ay) > 0.22) { x += ax; y += ay; this.usingPad = true; }
      if (b(0) || b(7)) { ping = true; this.padPing = true; }
      for (const [name, i] of PAD_EDGES) { const now = b(i); if (now && !this.padPrev[name]) this.edges.add(name); this.padPrev[name] = now; }
      // the left stick doubles as a menu d-pad
      const sx = ax > 0.6 ? 1 : ax < -0.6 ? -1 : 0, sy = ay > 0.6 ? 1 : ay < -0.6 ? -1 : 0;
      if (sx !== this.stick.x) { if (sx) this.edges.add(sx > 0 ? 'PadRight' : 'PadLeft'); this.stick.x = sx; }
      if (sy !== this.stick.y) { if (sy) this.edges.add(sy > 0 ? 'PadDown' : 'PadUp'); this.stick.y = sy; }
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
    if (action === 'padOk' && this.edges.delete('PadOk')) return true;
    if (action === 'menuUp' && this.edges.delete('PadUp')) return true;
    if (action === 'menuDown' && this.edges.delete('PadDown')) return true;
    if (action === 'menuLeft' && this.edges.delete('PadLeft')) return true;
    if (action === 'menuRight' && this.edges.delete('PadRight')) return true;
    return false;
  }

  endFrame() { this.edges.clear(); this.tap = false; }
}
