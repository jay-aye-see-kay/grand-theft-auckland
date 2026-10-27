// Cheat codes entered as flicks of the move stick, so the same code works on
// the keyboard (arrows or WASD), the touch stick and a gamepad: no text entry
// needed on a phone. A flick is the stick pushed past FLICK in one direction
// after being back near the centre.

export type Flick = 'U' | 'D' | 'L' | 'R';

/** Up, up, down, down, left, right, left, right: toggles flying. */
export const FLY_CODE: readonly Flick[] = ['U', 'U', 'D', 'D', 'L', 'R', 'L', 'R'];

const FLICK = 0.7;
const CENTRE = 0.3;
/** Longest pause between flicks before the sequence starts over, seconds. */
const GAP = 2;

export class StickCode {
  private readonly code: readonly Flick[];
  private recent: Flick[] = [];
  private armed = true;
  private lastFlick = -Infinity;

  constructor(code: readonly Flick[]) {
    this.code = code;
  }

  /** Feed the stick each frame (x right, y forward, -1..1); true when the code completes. */
  feed(x: number, y: number, now: number): boolean {
    if (Math.hypot(x, y) < CENTRE) {
      this.armed = true;
      return false;
    }
    if (!this.armed) return false;
    const flick: Flick | null =
      Math.abs(y) >= FLICK && Math.abs(y) > Math.abs(x) ? (y > 0 ? 'U' : 'D') : Math.abs(x) >= FLICK ? (x > 0 ? 'R' : 'L') : null;
    if (!flick) return false;
    this.armed = false;
    if (now - this.lastFlick > GAP) this.recent = [];
    this.lastFlick = now;
    // Match the last flicks against the code, so an extra flick at the start
    // (three ups) doesn't spoil it.
    this.recent.push(flick);
    if (this.recent.length > this.code.length) this.recent.shift();
    if (this.recent.length < this.code.length || this.recent.some((f, i) => f !== this.code[i])) return false;
    this.recent = [];
    return true;
  }
}
