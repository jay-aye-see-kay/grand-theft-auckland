import type { DriveControls } from './car.ts';

// Merges keyboard, on-screen touch controls and gamepad into one set of
// controls. The touch layout switches between on-foot and driving.
//
// Keyboard: WASD/arrows move or drive, Space jumps or handbrakes, Shift
// sprints, F/Enter gets in or out, R flips the car, M mutes.
// Gamepad (standard mapping): left stick, RT/LT pedals, A jump/handbrake,
// X sprint, Y in/out, Back flips the car.

export type Mode = 'foot' | 'car';

const pressed = (pad: Gamepad, i: number) => !!pad.buttons[i]?.pressed;

export class Input {
  readonly drive: DriveControls = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  /** Stick/keys: x is right, y is forward, each -1..1. */
  moveX = 0;
  moveY = 0;
  sprint = false;
  /** Space / A / jump button held (jump on foot, handbrake in a car). */
  action = false;

  // One-shot presses, cleared by consume().
  private edges = new Set<'enterExit' | 'reset' | 'jump' | 'mute'>();

  private readonly keys = new Set<string>();
  private readonly touch = { x: 0, y: 0, gas: false, brake: false, action: false, sprint: false };
  private readonly padHeld = new Set<number>();
  private readonly root: HTMLElement;
  private ui: HTMLElement | null = null;
  private mode: Mode = 'foot';
  private lookDX = 0;
  private padLookX = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    addEventListener('keydown', (e) => {
      if (!e.repeat) {
        if (e.code === 'KeyF' || e.code === 'Enter' || e.code === 'KeyE') this.edges.add('enterExit');
        if (e.code === 'KeyR') this.edges.add('reset');
        if (e.code === 'Space') this.edges.add('jump');
        if (e.code === 'KeyM') this.edges.add('mute');
      }
      this.keys.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    const touchy = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    if (touchy) this.buildTouchUi();
    else addEventListener('touchstart', () => this.buildTouchUi(), { once: true });
  }

  /** Drag on the game view (mouse or touch) or right stick to look around. */
  attachLook(el: HTMLElement): void {
    let active: number | null = null;
    let lastX = 0;
    el.addEventListener('pointerdown', (e) => {
      if (active !== null) return;
      active = e.pointerId;
      lastX = e.clientX;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== active) return;
      this.lookDX += e.clientX - lastX;
      lastX = e.clientX;
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === active) active = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  /** Pixels dragged (plus right stick) since the last call. */
  consumeLook(dt: number): number {
    const dx = this.lookDX + this.padLookX * dt * 900;
    this.lookDX = 0;
    return dx;
  }

  /** True once per press. */
  consume(edge: 'enterExit' | 'reset' | 'jump' | 'mute'): boolean {
    return this.edges.delete(edge);
  }

  /** Drop any presses queued up, e.g. the key that dismissed the title screen. */
  clearPresses(): void {
    this.edges.clear();
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.ui?.setAttribute('data-mode', mode);
  }

  /** Light up the in/out button when there's a car to get into. */
  setCanEnter(can: boolean): void {
    this.ui?.querySelector('.btn-enter')?.classList.toggle('ready', can);
  }

  update(): void {
    const k = this.keys;
    const up = k.has('KeyW') || k.has('ArrowUp');
    const down = k.has('KeyS') || k.has('ArrowDown');
    const right = k.has('KeyD') || k.has('ArrowRight');
    const left = k.has('KeyA') || k.has('ArrowLeft');

    let moveX = (right ? 1 : 0) - (left ? 1 : 0);
    let moveY = (up ? 1 : 0) - (down ? 1 : 0);
    if (moveX === 0 && moveY === 0) {
      moveX = this.touch.x;
      moveY = this.touch.y;
    }
    let throttle = up || this.touch.gas ? 1 : 0;
    let brake = down || this.touch.brake ? 1 : 0;
    let action = k.has('Space') || this.touch.action;
    let sprint = k.has('ShiftLeft') || k.has('ShiftRight') || this.touch.sprint;

    this.padLookX = 0;
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad || pad.mapping !== 'standard') continue;
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      if (Math.hypot(ax, ay) > 0.15 && moveX === 0 && moveY === 0) {
        moveX = ax;
        moveY = -ay;
      }
      const rx = pad.axes[2] ?? 0;
      if (Math.abs(rx) > 0.15) this.padLookX = rx;
      throttle = Math.max(throttle, pad.buttons[7]?.value ?? 0);
      brake = Math.max(brake, pad.buttons[6]?.value ?? 0);
      action ||= pressed(pad, 0);
      sprint ||= pressed(pad, 2);
      const edge = (i: number, name: 'enterExit' | 'reset' | 'jump') => {
        if (pressed(pad, i) && !this.padHeld.has(i)) this.edges.add(name);
        if (pressed(pad, i)) this.padHeld.add(i);
        else this.padHeld.delete(i);
      };
      edge(3, 'enterExit');
      edge(8, 'reset');
      edge(0, 'jump');
      break;
    }

    this.moveX = moveX;
    this.moveY = moveY;
    this.action = action;
    this.sprint = sprint;
    Object.assign(this.drive, { throttle, brake, steer: moveX, handbrake: action });
  }

  private buildTouchUi(): void {
    if (this.ui) return;
    const ui = document.createElement('div');
    ui.className = 'touch';
    ui.setAttribute('data-mode', this.mode);
    ui.innerHTML = `
      <div class="stick"><div class="stick-knob"></div></div>
      <button class="btn btn-enter" aria-label="Get in or out">🚗</button>
      <button class="btn btn-reset car-only" aria-label="Flip car">⟲</button>
      <button class="btn btn-action" aria-label="Handbrake or jump"><span class="car-only">HB</span><span class="foot-only">JUMP</span></button>
      <button class="btn btn-brake car-only" aria-label="Brake / reverse">◀</button>
      <button class="btn btn-gas car-only" aria-label="Accelerate">▲</button>
      <button class="btn btn-sprint foot-only" aria-label="Sprint">RUN</button>
    `;
    this.root.appendChild(ui);
    this.ui = ui;

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
    hold('.btn-gas', (on) => (this.touch.gas = on));
    hold('.btn-brake', (on) => (this.touch.brake = on));
    hold('.btn-sprint', (on) => (this.touch.sprint = on));
    hold('.btn-action', (on) => {
      this.touch.action = on;
      if (on) this.edges.add('jump');
    });
    hold('.btn-reset', (on) => on && this.edges.add('reset'));
    hold('.btn-enter', (on) => on && this.edges.add('enterExit'));

    // Analogue stick. Driving only uses x; on foot it's a full 2D stick.
    const stick = ui.querySelector<HTMLElement>('.stick')!;
    const knob = ui.querySelector<HTMLElement>('.stick-knob')!;
    let active: number | null = null;
    let ox = 0;
    let oy = 0;
    const radius = 56;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== active) return;
      let dx = e.clientX - ox;
      let dy = e.clientY - oy;
      if (this.mode === 'car') dy = 0;
      const d = Math.hypot(dx, dy);
      if (d > radius) {
        dx *= radius / d;
        dy *= radius / d;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const curve = (v: number) => Math.sign(v) * Math.min(1, Math.abs(v) * 1.15);
      this.touch.x = curve(dx / radius);
      this.touch.y = curve(-dy / radius);
    };
    stick.addEventListener('pointerdown', (e) => {
      active = e.pointerId;
      stick.setPointerCapture(e.pointerId);
      const r = stick.getBoundingClientRect();
      ox = r.left + r.width / 2;
      oy = r.top + r.height / 2;
      move(e);
    });
    stick.addEventListener('pointermove', move);
    const release = (e: PointerEvent) => {
      if (e.pointerId !== active) return;
      active = null;
      this.touch.x = this.touch.y = 0;
      knob.style.transform = '';
    };
    stick.addEventListener('pointerup', release);
    stick.addEventListener('pointercancel', release);
  }
}
