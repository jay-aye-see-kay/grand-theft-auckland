import type { DriveControls } from './car.ts';

// Merges keyboard, on-screen touch controls and gamepad into one set of
// drive controls. Touch UI is built here and only shown on touch devices.

export class Input {
  readonly controls: DriveControls = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  /** Set for one frame when reset is requested. */
  resetPressed = false;

  private readonly keys = new Set<string>();
  private touchSteer = 0;
  private touchGas = false;
  private touchBrake = false;
  private touchHandbrake = false;
  private touchReset = false;
  private gamepadResetHeld = false;
  private readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    addEventListener('keydown', (e) => {
      if (e.code === 'KeyR' && !e.repeat) this.resetPressed = true;
      this.keys.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    const touchy = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    if (touchy) this.buildTouchUi();
    else addEventListener('touchstart', () => this.buildTouchUi(), { once: true });
  }

  update(): void {
    const k = this.keys;
    let throttle = k.has('KeyW') || k.has('ArrowUp') || this.touchGas ? 1 : 0;
    let brake = k.has('KeyS') || k.has('ArrowDown') || this.touchBrake ? 1 : 0;
    let steer = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    if (steer === 0) steer = this.touchSteer;
    let handbrake = k.has('Space') || this.touchHandbrake;

    // First connected gamepad, standard mapping: RT gas, LT brake, A handbrake, Y reset.
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad || pad.mapping !== 'standard') continue;
      throttle = Math.max(throttle, pad.buttons[7]?.value ?? 0);
      brake = Math.max(brake, pad.buttons[6]?.value ?? 0);
      const x = pad.axes[0] ?? 0;
      if (Math.abs(x) > 0.15 && steer === 0) steer = x;
      handbrake ||= !!pad.buttons[0]?.pressed;
      const y = !!pad.buttons[3]?.pressed;
      if (y && !this.gamepadResetHeld) this.resetPressed = true;
      this.gamepadResetHeld = y;
      break;
    }

    if (this.touchReset) {
      this.resetPressed = true;
      this.touchReset = false;
    }
    Object.assign(this.controls, { throttle, brake, steer, handbrake });
  }

  private buildTouchUi(): void {
    if (this.root.querySelector('.touch')) return;
    const ui = document.createElement('div');
    ui.className = 'touch';
    ui.innerHTML = `
      <div class="stick"><div class="stick-knob"></div></div>
      <button class="btn btn-reset" aria-label="Flip car">⟲</button>
      <button class="btn btn-handbrake" aria-label="Handbrake">HB</button>
      <button class="btn btn-brake" aria-label="Brake / reverse">◀</button>
      <button class="btn btn-gas" aria-label="Accelerate">▲</button>
    `;
    this.root.appendChild(ui);

    const hold = (sel: string, set: (on: boolean) => void) => {
      const el = ui.querySelector<HTMLElement>(sel)!;
      el.addEventListener('pointerdown', (e) => {
        el.setPointerCapture(e.pointerId);
        el.classList.add('down');
        set(true);
      });
      const up = () => {
        el.classList.remove('down');
        set(false);
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    };
    hold('.btn-gas', (on) => (this.touchGas = on));
    hold('.btn-brake', (on) => (this.touchBrake = on));
    hold('.btn-handbrake', (on) => (this.touchHandbrake = on));
    hold('.btn-reset', (on) => on && (this.touchReset = true));

    // Steering stick: horizontal only, recentres on release.
    const stick = ui.querySelector<HTMLElement>('.stick')!;
    const knob = ui.querySelector<HTMLElement>('.stick-knob')!;
    let active: number | null = null;
    let originX = 0;
    const radius = 56;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== active) return;
      const dx = Math.max(-radius, Math.min(radius, e.clientX - originX));
      knob.style.transform = `translateX(${dx}px)`;
      const v = dx / radius;
      this.touchSteer = Math.sign(v) * Math.min(1, Math.abs(v) * 1.15);
    };
    stick.addEventListener('pointerdown', (e) => {
      active = e.pointerId;
      stick.setPointerCapture(e.pointerId);
      const r = stick.getBoundingClientRect();
      originX = r.left + r.width / 2;
      move(e);
    });
    stick.addEventListener('pointermove', move);
    const release = (e: PointerEvent) => {
      if (e.pointerId !== active) return;
      active = null;
      this.touchSteer = 0;
      knob.style.transform = '';
    };
    stick.addEventListener('pointerup', release);
    stick.addEventListener('pointercancel', release);
  }
}
