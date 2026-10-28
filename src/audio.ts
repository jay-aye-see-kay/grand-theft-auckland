// All game sound is synthesised with Web Audio: no files to download.
// Engine: two detuned oscillators through a throttle-driven low-pass filter,
// pitch following a fake 5-speed gearbox. Tyres: band-passed noise.
// Crashes: a noise burst plus a low thump. Footsteps: tiny filtered clicks.
// Splashes: a falling wash of noise and a gloop.
//
// Browsers only allow audio after a user gesture, so nothing is created
// until unlock() is called from the start tap/click.

const GEAR_TOP = [9, 17, 26, 36, 60]; // m/s at the top of each gear

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private osc1!: OscillatorNode;
  private osc2!: OscillatorNode;
  private skidGain!: GainNode;
  private skidFilter!: BiquadFilterNode;
  private noise!: AudioBuffer;
  private lastImpact = 0;
  private muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem('gta-muted') === '1';
    } catch {
      // Storage blocked; default to sound on.
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  get state(): string {
    return this.ctx?.state ?? 'locked';
  }

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

    // 2 s of white noise, shared by tyres, crashes and footsteps.
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    // Engine.
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.Q.value = 4;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter.connect(this.engineGain).connect(this.master);
    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'square';
    const g2 = ctx.createGain();
    g2.gain.value = 0.5;
    this.osc1.connect(this.engineFilter);
    this.osc2.connect(g2).connect(this.engineFilter);
    this.osc1.start();
    this.osc2.start();

    // Tyre screech.
    const skidSrc = ctx.createBufferSource();
    skidSrc.buffer = this.noise;
    skidSrc.loop = true;
    this.skidFilter = ctx.createBiquadFilter();
    this.skidFilter.type = 'bandpass';
    this.skidFilter.frequency.value = 1500;
    this.skidFilter.Q.value = 6;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    skidSrc.connect(this.skidFilter).connect(this.skidGain).connect(this.master);
    skidSrc.start();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    try {
      localStorage.setItem('gta-muted', this.muted ? '1' : '0');
    } catch {
      // Not persisted; still applies for this session.
    }
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  /** Call every frame. running=false fades the engine out (on foot). */
  setEngine(running: boolean, speed: number, throttle: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = Math.abs(speed);
    let gear = GEAR_TOP.findIndex((top) => s < top);
    if (gear < 0) gear = GEAR_TOP.length - 1;
    const low = gear === 0 ? 0 : GEAR_TOP[gear - 1] * 0.75;
    const rpm = Math.min(1, 0.18 + (0.82 * (s - low)) / (GEAR_TOP[gear] - low) + throttle * 0.08);
    const freq = 32 + rpm * 110;
    this.osc1.frequency.setTargetAtTime(freq, t, 0.04);
    this.osc2.frequency.setTargetAtTime(freq * 0.501, t, 0.04);
    this.engineFilter.frequency.setTargetAtTime(250 + rpm * 900 + throttle * 900, t, 0.05);
    const vol = running ? 0.1 + throttle * 0.12 + rpm * 0.05 : 0;
    this.engineGain.gain.setTargetAtTime(vol, t, running ? 0.08 : 0.3);
  }

  /** Tyre screech amount 0..1, every frame. */
  setSkid(amount: number, speed: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.skidGain.gain.setTargetAtTime(amount > 0.2 ? Math.min(amount, 1) * 0.22 : 0, t, 0.05);
    this.skidFilter.frequency.setTargetAtTime(1200 + Math.min(Math.abs(speed), 30) * 20, t, 0.1);
  }

  /** A crash or hard landing. strength ~0..1. */
  impact(strength: number): void {
    if (!this.ctx || strength <= 0) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    if (t - this.lastImpact < 0.12) return;
    this.lastImpact = t;
    const s = Math.min(1, strength);

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.6 + Math.random() * 0.3;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500 + s * 2500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25 + s * 0.6, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15 + s * 0.35);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5, 0.6);

    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(90, t);
    thump.frequency.exponentialRampToValueAtTime(35, t + 0.25);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.3 + s * 0.5, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    thump.connect(tg).connect(this.master);
    thump.start(t);
    thump.stop(t + 0.32);
  }

  /** Something hits the water: a wash of low noise, a sharp slap and a gloop. strength ~0..1. */
  splash(strength: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = Math.min(1, Math.max(0.2, strength));

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.5;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2500 + s * 2500, t);
    filter.frequency.exponentialRampToValueAtTime(300, t + 1.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35 + s * 0.45, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.3);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5, 1.4);

    const gloop = ctx.createOscillator();
    gloop.type = 'sine';
    gloop.frequency.setValueAtTime(320, t + 0.05);
    gloop.frequency.exponentialRampToValueAtTime(90, t + 0.35);
    const gg = ctx.createGain();
    gg.gain.setValueAtTime(0.0001, t);
    gg.gain.exponentialRampToValueAtTime(0.25 * s, t + 0.07);
    gg.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    gloop.connect(gg).connect(this.master);
    gloop.start(t);
    gloop.stop(t + 0.42);
  }

  /** Mission jingles: a rising arpeggio to start or pass, a ding at a checkpoint, a sad slide on failure. */
  cue(kind: 'start' | 'reached' | 'passed' | 'failed'): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // Semitones from A4, each note 0.11 s apart.
    const tunes = { start: [0, 4, 7], reached: [7, 12], passed: [0, 4, 7, 12, 16, 19, 24], failed: [7, 6, 5, 4] };
    const notes = tunes[kind];
    for (const [i, n] of notes.entries()) {
      const at = t + i * 0.11;
      const last = i === notes.length - 1;
      const osc = ctx.createOscillator();
      osc.type = kind === 'failed' ? 'sawtooth' : 'square';
      osc.frequency.setValueAtTime(440 * 2 ** (n / 12), at);
      if (kind === 'failed' && last) osc.frequency.exponentialRampToValueAtTime(440 * 2 ** (-8 / 12), at + 0.6);
      const len = last ? 0.6 : 0.1;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.09, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, at + len);
      osc.connect(g).connect(this.master);
      osc.start(at);
      osc.stop(at + len + 0.02);
    }
  }

  footstep(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900 + Math.random() * 500;
    filter.Q.value = 1.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.8, 0.08);
  }
}
