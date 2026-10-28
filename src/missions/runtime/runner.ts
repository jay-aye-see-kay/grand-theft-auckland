import type { Clock, GoToOptions, Mission, MissionApi, MissionPlayer } from './mission.ts';
import type { Place } from './places.ts';

// Runs mission scripts against the game, a tick at a time in game time, so
// the smoke test's stepped clock plays them back exactly. Owns no DOM or
// three.js: the HUD and markers read `view()` every frame.
//
// A script awaits promises that ticks resolve. When the mission ends, every
// pending promise rejects with MissionOver, which unwinds the script, and
// any further call from it throws the same: a finished script can't touch
// the next mission.

/** Walk this close to a start marker to start it, m (driving: a bit wider). */
const START_RADIUS = { foot: 2.2, car: 4.5 };
/** Show "<title>: step into the marker" this close, m. */
const HINT_RADIUS = 18;
/** Leave a marker by this much after a mission ends before it can start again, m. */
const REARM = 4;
/** Markers and goals are on the ground: this much height difference still counts (not from a plane overhead), m. */
const REACH_Y = 6;
/** How long the title card and the result banner stay up, s. */
const CARD = 4;
const DEFAULT_RADIUS = 6;
/** The sun is fixed mid-afternoon (sun.ts). */
const HOUR = 15;
const RECORD_KEY = 'gta.best.';

/** What the runner needs from the game each tick. */
export interface Snapshot {
  /** Game time, s. */
  clock: number;
  x: number;
  y: number;
  z: number;
  driving: boolean;
  speedKmh: number;
  /** The driven car's biggest knock this tick, m/s (0 on foot). */
  crash: number;
}

/** What the HUD and markers draw. */
export interface MissionView {
  active: string | null;
  /** Big centred text: a mission's title card, or MISSION PASSED / FAILED. */
  banner: { title: string; text: string; kind: 'start' | 'passed' | 'failed' } | null;
  subtitle: string | null;
  objective: string;
  clock: { seconds: number; down: boolean } | null;
  /** The goal: a tall beam and the screen-edge arrow. */
  target: { x: number; z: number; label: string } | null;
  /** Start markers to draw (idle only). */
  starts: { id: string; title: string; x: number; z: number }[];
  /** Nearest start (idle only), for the gold arrow. */
  nearest: { id: string; title: string; x: number; z: number } | null;
  /** Next to a start marker: what to do. */
  hint: string;
}

export type Cue = 'start' | 'reached' | 'passed' | 'failed';

class MissionOver extends Error {
  constructor() {
    super('mission over');
  }
}

interface Pending {
  test: () => boolean;
  resolve: () => void;
  reject: (e: unknown) => void;
}

interface Run {
  mission: Mission;
  started: number;
  pending: Pending[];
  guards: { test: () => boolean; message: string }[];
  crash: ((strength: number) => void)[];
  /** Countdowns: what happens when each runs out. */
  deadlines: { at: number; expire: () => void }[];
  clock: { from: number; down: boolean } | null;
  target: { place: Place; label: string } | null;
  objective: string;
}

export class MissionRunner {
  readonly missions: readonly Mission[];
  private readonly storage: Storage | null;
  private run: Run | null = null;
  private now = 0;
  private me: MissionPlayer = { name: 'You', x: 0, y: 0, z: 0, driving: false, speedKmh: 0 };
  /** Mission id -> may start (false until you've left its marker after it ended). */
  private readonly armed = new Map<string, boolean>();
  private banner: (MissionView['banner'] & { until: number }) | null = null;
  private subtitle: { text: string; until: number } | null = null;
  private hint = '';
  /** How the last mission ended, for the smoke test. */
  private last: { id: string; result: 'passed' | 'failed'; message: string } | null = null;
  private readonly said: string[] = [];
  /** Sounds to play, taken each frame by the game. */
  private cues: Cue[] = [];

  /** Ground height at a point, NaN where unknown. */
  private readonly groundAt: (x: number, z: number) => number;

  constructor(missions: readonly Mission[], groundAt: (x: number, z: number) => number, storage: Storage | null) {
    this.missions = missions;
    this.groundAt = groundAt;
    this.storage = storage;
  }

  get active(): Mission | null {
    return this.run?.mission ?? null;
  }

  /** One game tick (or frame): start missions, advance the running one. */
  tick(s: Snapshot): void {
    this.now = s.clock;
    this.me = { name: 'You', x: s.x, y: s.y, z: s.z, driving: s.driving, speedKmh: s.speedKmh };
    if (this.banner && this.now > this.banner.until) this.banner = null;
    if (this.subtitle && this.now > this.subtitle.until) this.subtitle = null;
    const run = this.run;
    if (!run) {
      this.idle(s);
      return;
    }
    this.hint = '';
    try {
      if (s.crash > 0) for (const fn of run.crash) fn(s.crash);
      for (const g of run.guards) if (g.test()) this.fail(run, g.message);
      for (const d of run.deadlines) if (this.now >= d.at) d.expire();
      run.deadlines = run.deadlines.filter((d) => this.now < d.at);
      // Resolve in order; a resolved wait's script only continues after this tick.
      const done = run.pending.filter((p) => p.test());
      run.pending = run.pending.filter((p) => !done.includes(p));
      for (const p of done) p.resolve();
    } catch (e) {
      if (!(e instanceof MissionOver)) this.crashed(run, e);
    }
  }

  /** Abandon any mission and forget results (?debug reset). */
  reset(): void {
    if (this.run) this.end(this.run, 'failed', '');
    this.cues = [];
    this.armed.clear();
    this.banner = this.subtitle = this.last = null;
    this.said.length = 0;
    this.hint = '';
  }

  /** Start one by id, wherever the player is (?debug). */
  start(id: string): void {
    const mission = this.missions.find((m) => m.id === id);
    if (!mission) throw new Error(`no mission ${id}`);
    if (this.run) this.end(this.run, 'failed', '');
    this.begin(mission);
  }

  /** Sounds since the last call: mission start and end, goals reached. */
  takeCues(): Cue[] {
    const cues = this.cues;
    this.cues = [];
    return cues;
  }

  view(): MissionView {
    const run = this.run;
    const starts = run ? [] : this.missions.filter((m) => this.available(m)).map((m) => ({ id: m.id, title: m.title, x: m.start.x, z: m.start.z }));
    let nearest: MissionView['nearest'] = null;
    let best = Infinity;
    for (const s of starts) {
      const d = Math.hypot(s.x - this.me.x, s.z - this.me.z);
      if (d < best) [best, nearest] = [d, s];
    }
    return {
      active: run?.mission.id ?? null,
      banner: this.banner,
      subtitle: this.subtitle?.text ?? null,
      objective: run?.objective ?? '',
      clock: run?.clock ? { seconds: run.clock.down ? run.clock.from - this.now : this.now - run.clock.from, down: run.clock.down } : null,
      target: run?.target ? { x: run.target.place.x, z: run.target.place.z, label: run.target.label } : null,
      starts,
      nearest,
      hint: this.hint,
    };
  }

  /** ?debug: the view plus how the last mission went and everything said. */
  debugState() {
    return { ...this.view(), last: this.last, said: [...this.said], missions: this.missions.map((m) => ({ id: m.id, title: m.title, start: m.start })) };
  }

  private available(m: Mission): boolean {
    const players = [this.me];
    if (m.players && (players.length < m.players.min || players.length > m.players.max)) return false;
    return m.available?.({ hour: HOUR, players }) ?? true;
  }

  private idle(s: Snapshot): void {
    this.hint = '';
    for (const m of this.missions) {
      if (!this.available(m)) continue;
      const d = Math.hypot(m.start.x - s.x, m.start.z - s.z);
      const radius = s.driving ? START_RADIUS.car : START_RADIUS.foot;
      if (d > radius + REARM) this.armed.set(m.id, true);
      if (d < HINT_RADIUS && !this.hint) {
        if (m.needsCar && !s.driving) this.hint = `${m.title}: bring a car`;
        else if (this.armed.get(m.id) !== false) this.hint = `${m.title}: ${s.driving ? 'drive' : 'step'} into the marker`;
      }
      if (d < radius && this.armed.get(m.id) !== false && (!m.needsCar || s.driving) && this.grounded(s)) {
        this.begin(m);
        return;
      }
    }
  }

  private begin(mission: Mission): void {
    const run: Run = { mission, started: this.now, pending: [], guards: [], crash: [], deadlines: [], clock: null, target: null, objective: '' };
    this.run = run;
    this.armed.set(mission.id, false);
    this.subtitle = null;
    this.banner = { title: mission.title, text: mission.blurb, kind: 'start', until: this.now + CARD };
    this.cues.push('start');
    mission.run(this.api(run)).then(
      () => this.end(run, 'passed', ''),
      (e) => {
        if (!(e instanceof MissionOver)) this.crashed(run, e);
      },
    );
  }

  /** A bug in a mission script: say so in the console (smoke fails on it) and end it. */
  private crashed(run: Run, e: unknown): void {
    console.error(`mission ${run.mission.id}:`, e);
    this.end(run, 'failed', 'The mission broke. Blame the writer.');
  }

  private end(run: Run, result: 'passed' | 'failed', message: string): void {
    if (this.run !== run) return;
    this.run = null;
    this.last = { id: run.mission.id, result, message };
    if (message) this.said.push(message);
    this.banner = { title: result === 'passed' ? 'Mission passed!' : 'Mission failed!', text: message, kind: result, until: this.now + CARD };
    if (message || result === 'passed') this.cues.push(result);
    this.subtitle = null;
    const over = new MissionOver();
    for (const p of run.pending) p.reject(over);
    run.pending = [];
  }

  private fail(run: Run, message: string): never {
    this.end(run, 'failed', message);
    throw new MissionOver();
  }

  private api(run: Run): MissionApi {
    const self = this;
    /** Every call from a finished script throws, so it unwinds instead of meddling. */
    const live = () => {
      if (this.run !== run) throw new MissionOver();
    };
    const wait = (test: () => boolean): Promise<void> => {
      live();
      return new Promise((resolve, reject) => run.pending.push({ test, resolve, reject }));
    };
    const reached = (place: Place, o: GoToOptions = {}) => {
      const me = this.me;
      return Math.hypot(place.x - me.x, place.z - me.z) < (o.radius ?? DEFAULT_RADIUS) && (!o.inCar || me.driving) && this.grounded(me);
    };
    const mark = (place: Place, o: GoToOptions) => {
      run.target = { place, label: place.name };
      run.objective = o.label ?? `Go to ${place.name}`;
    };
    const unmark = (place: Place) => {
      if (this.run === run && run.target?.place === place) {
        run.target = null;
        run.objective = '';
      }
    };
    /** Shows a clock; a countdown's `deadline` goes when it's stopped. */
    const clock = (from: number, down: boolean, deadline?: Run['deadlines'][number]): Clock => {
      const c = { from, down };
      run.clock = c;
      if (deadline) run.deadlines.push(deadline);
      return {
        get seconds() {
          return down ? c.from - self.now : self.now - c.from;
        },
        stop: () => {
          if (run.clock === c) run.clock = null;
          run.deadlines = run.deadlines.filter((d) => d !== deadline);
        },
      };
    };
    const api: MissionApi = {
      get players() {
        return [self.me];
      },
      get player() {
        return self.me;
      },
      get elapsed() {
        return self.now - run.started;
      },
      say: (text, seconds = 4) => {
        live();
        this.subtitle = { text, until: this.now + seconds };
        this.said.push(text);
      },
      objective: (text) => {
        live();
        run.objective = text;
      },
      goTo: async (place, o = {}) => {
        mark(place, o);
        await wait(() => reached(place, o));
        unmark(place);
        this.cues.push('reached');
        return this.me;
      },
      race: async (_players, place, o) => {
        mark(place, o);
        const at = this.now + o.seconds;
        let late = false;
        const c = clock(at, true, { at, expire: () => (late = true) });
        await wait(() => late || reached(place, o));
        c.stop();
        unmark(place);
        return late ? null : this.me;
      },
      waitFor: async (test, label) => {
        if (label !== undefined) run.objective = label;
        await wait(test);
        if (label !== undefined && this.run === run && run.objective === label) run.objective = '';
      },
      wait: (seconds) => {
        const at = this.now + seconds;
        return wait(() => this.now >= at);
      },
      timer: (seconds, message) => {
        live();
        const at = this.now + seconds;
        return clock(at, true, { at, expire: () => this.fail(run, message) });
      },
      stopwatch: () => {
        live();
        return clock(this.now, false);
      },
      failIf: (test, message) => {
        live();
        run.guards.push({ test, message });
      },
      onCrash: (fn) => {
        live();
        run.crash.push(fn);
      },
      record: (seconds) => {
        const key = RECORD_KEY + run.mission.id;
        let best = Infinity;
        try {
          best = Number(this.storage?.getItem(key) ?? Infinity);
        } catch {
          // storage blocked (private mode): every time is a record
        }
        const isNew = !(seconds >= best);
        if (isNew) {
          best = seconds;
          try {
            this.storage?.setItem(key, String(seconds));
          } catch {
            // as above
          }
        }
        return { best, isNew };
      },
      succeed: (message = '') => {
        live();
        this.end(run, 'passed', message);
        throw new MissionOver();
      },
      fail: (message) => {
        live();
        return this.fail(run, message);
      },
    };
    return api;
  }

  /** On the ground near a marker, not flying over it (unknown ground counts as on it). */
  private grounded(p: { x: number; y: number; z: number }): boolean {
    const g = this.groundAt(p.x, p.z);
    return Number.isNaN(g) || Math.abs(p.y - g) < REACH_Y;
  }
}
