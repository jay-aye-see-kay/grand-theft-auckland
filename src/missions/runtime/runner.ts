import type { Clock, GoToOptions, Mission, MissionApi, MissionPlayer } from './mission.ts';
import type { Gazetteer, Place } from './places.ts';

// Runs mission scripts against the game, a tick at a time in game time, so
// the smoke test's stepped clock plays them back exactly. Owns no DOM or
// three.js: the HUD and markers read `view()` every frame.
//
// A script awaits promises that ticks resolve. When the mission ends, every
// pending promise rejects with MissionOver, which unwinds the script, and
// any further call from it throws the same: a finished script can't touch
// the next mission.
//
// In a room, a mission for more than one is shared: the host runs it with
// everyone as `players` (their poses, as drawn ~0.12 s behind) and sends
// `share()` to the guests, who `mirror()` it: same banner, subtitles, clock
// and beams, no script. A guest stepping into a shared marker asks the host
// to start it. Solo missions run wherever they're started, unshared.

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
/** Everyone in the room must be this close to a shared mission's marker for it to start, m. */
const GATHER = 40;
/** A guest asks the host to start a shared mission this often while standing in its marker (the channel drops packets), s. */
const ASK_EVERY = 0.5;
/** A guest drops a shared mission it has heard nothing of for this long, s. */
const MIRROR_SILENCE = 3;
/** Cues kept in the shared state, so a guest hears each once though some states are lost. */
const CUE_LOG = 8;

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
  /** Our id and name in the room. */
  id: number;
  name: string;
  /** Everyone else in the room. */
  others: readonly MissionPlayer[];
  /** In someone else's room: their shared missions are theirs to run. */
  guest: boolean;
}

/** What the host sends guests about a shared mission, several times a second. Times are relative: clocks differ. */
export interface SharedMission {
  /** Running (null: it has ended and the result banner is up). */
  id: string | null;
  banner: (NonNullable<MissionView['banner']> & { left: number }) | null;
  subtitle: { text: string; left: number } | null;
  objective: string;
  clock: { seconds: number; down: boolean } | null;
  targets: { x: number; z: number; label: string }[];
  /** Recent sounds, numbered. */
  cues: [number, Cue][];
  /** How the last shared mission ended, numbered. */
  last: { n: number; id: string; result: 'passed' | 'failed'; message: string } | null;
}

/** What the HUD and markers draw. */
export interface MissionView {
  active: string | null;
  /** Big centred text: a mission's title card, or MISSION PASSED / FAILED. */
  banner: { title: string; text: string; kind: 'start' | 'passed' | 'failed' } | null;
  subtitle: string | null;
  objective: string;
  clock: { seconds: number; down: boolean } | null;
  /** The goals: tall beams. */
  targets: { x: number; z: number; label: string }[];
  /** The nearest goal, for the screen-edge arrow. */
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
  targets: Place[];
  objective: string;
  shared: boolean;
}

export class MissionRunner {
  readonly missions: readonly Mission[];
  private readonly places: Gazetteer;
  /** Mission id -> its start marker's place. */
  private readonly starts: Map<string, Place>;
  private readonly storage: Storage | null;
  private run: Run | null = null;
  private now = 0;
  private me: MissionPlayer = { id: 0, name: 'You', x: 0, y: 0, z: 0, driving: false, speedKmh: 0 };
  private others: readonly MissionPlayer[] = [];
  private guest = false;
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
  /** Host: recent cues of the shared mission, numbered, and how its last one ended. */
  private cueLog: [number, Cue][] = [];
  private cueCount = 0;
  private sharedLast: SharedMission['last'] = null;
  /** Host: share the result banner until then. */
  private sharingUntil = -Infinity;
  /** Guest: the host's shared mission as last heard, and when (our clock). */
  private mirrored: { state: SharedMission; at: number } | null = null;
  private heardCue = 0;
  private heardLast = 0;
  /** Guest: shared missions to ask the host to start, and when we last asked. */
  private requests: string[] = [];
  private asked = -Infinity;

  /** Ground height at a point, NaN where unknown. */
  private readonly groundAt: (x: number, z: number) => number;

  constructor(missions: readonly Mission[], places: Gazetteer, groundAt: (x: number, z: number) => number, storage: Storage | null) {
    this.missions = missions;
    this.places = places;
    // Unknown ids throw here, at start-up, rather than when someone walks past.
    this.starts = new Map(missions.map((m) => [m.id, places.get(m.start)]));
    this.groundAt = groundAt;
    this.storage = storage;
  }

  get active(): Mission | null {
    return this.run?.mission ?? null;
  }

  /** One game tick (or frame): start missions, advance the running one. */
  tick(s: Snapshot): void {
    if (s.clock < this.asked) this.asked = -Infinity; // reset
    this.now = s.clock;
    this.me = { id: s.id, name: s.name, x: s.x, y: s.y, z: s.z, driving: s.driving, speedKmh: s.speedKmh };
    this.others = s.others;
    this.guest = s.guest;
    if (this.banner && this.now > this.banner.until) this.banner = null;
    if (this.subtitle && this.now > this.subtitle.until) this.subtitle = null;
    if (this.mirrored && !s.guest) this.lostHost();
    if (this.mirrored && this.now - this.mirrored.at > MIRROR_SILENCE) this.mirrored = null;
    if (this.following()) {
      // The host's mission takes over from any of our own (its result banner doesn't).
      if (this.run) this.abandon(this.run);
      this.hint = '';
      return;
    }
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
    this.cueLog = [];
    this.sharedLast = null;
    this.sharingUntil = -Infinity;
    this.mirrored = null;
    this.requests = [];
    this.asked = -Infinity;
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

  /** Host: a guest stepped into a shared mission's marker. Starts it if nothing's running and everyone's there. */
  request(id: string): void {
    const mission = this.missions.find((m) => m.id === id);
    if (this.run || !mission || !shared(mission) || !this.available(mission) || !this.gathered(mission).all) return;
    this.begin(mission);
  }

  /** Guest: shared missions to ask the host for, since the last call. */
  takeRequests(): string[] {
    const r = this.requests;
    this.requests = [];
    return r;
  }

  /** Host: the shared mission for the guests, or null when there's nothing to share. */
  share(): SharedMission | null {
    const run = this.run?.shared ? this.run : null;
    if (!run && this.now > this.sharingUntil) return null;
    const v = this.view();
    return {
      id: run?.mission.id ?? null,
      banner: this.banner && { title: this.banner.title, text: this.banner.text, kind: this.banner.kind, left: this.banner.until - this.now },
      subtitle: run && this.subtitle && { text: this.subtitle.text, left: this.subtitle.until - this.now },
      objective: v.objective,
      clock: v.clock,
      targets: v.targets,
      cues: this.cueLog,
      last: this.sharedLast,
    };
  }

  /** Guest: the host's latest shared state. */
  mirror(state: SharedMission): void {
    if (!this.guest) return;
    const prev = this.mirrored?.state;
    this.mirrored = { state, at: this.now };
    if (state.id) this.armed.set(state.id, false);
    for (const [n, cue] of state.cues) {
      if (n > this.heardCue) this.cues.push(cue);
    }
    this.heardCue = Math.max(this.heardCue, ...state.cues.map(([n]) => n));
    if (state.subtitle && state.subtitle.text !== prev?.subtitle?.text) this.said.push(state.subtitle.text);
    if (state.last && state.last.n !== this.heardLast) {
      this.heardLast = state.last.n;
      this.last = { id: state.last.id, result: state.last.result, message: state.last.message };
      if (state.last.message) this.said.push(state.last.message);
    }
  }

  /** Sounds since the last call: mission start and end, goals reached. */
  takeCues(): Cue[] {
    const cues = this.cues;
    this.cues = [];
    return cues;
  }

  view(): MissionView {
    const mirror = this.mirrored;
    const age = mirror ? this.now - mirror.at : 0;
    const sb = mirror?.state.banner;
    const shownBanner = sb && sb.left - age > 0 ? { title: sb.title, text: sb.text, kind: sb.kind } : null;
    if (mirror && this.following()) {
      const { state } = mirror;
      const banner = shownBanner;
      return {
        active: state.id,
        banner,
        subtitle: state.subtitle && state.subtitle.left - age > 0 ? state.subtitle.text : null,
        objective: state.objective,
        clock: state.clock && { seconds: state.clock.seconds + (state.clock.down ? -age : age), down: state.clock.down },
        targets: state.targets,
        target: this.nearestOf(state.targets),
        starts: [],
        nearest: null,
        hint: '',
      };
    }
    const run = this.run;
    const starts = run ? [] : this.missions.filter((m) => this.available(m)).map((m) => ({ id: m.id, title: m.title, x: this.startOf(m).x, z: this.startOf(m).z }));
    let nearest: MissionView['nearest'] = null;
    let best = Infinity;
    for (const s of starts) {
      const d = Math.hypot(s.x - this.me.x, s.z - this.me.z);
      if (d < best) [best, nearest] = [d, s];
    }
    return {
      active: run?.mission.id ?? null,
      banner: this.banner ?? shownBanner,
      subtitle: this.subtitle?.text ?? null,
      objective: run?.objective ?? '',
      clock: run?.clock ? { seconds: run.clock.down ? run.clock.from - this.now : this.now - run.clock.from, down: run.clock.down } : null,
      targets: run ? run.targets.map((p) => ({ x: p.x, z: p.z, label: p.name })) : [],
      target: run ? this.nearestOf(run.targets.map((p) => ({ x: p.x, z: p.z, label: p.name }))) : null,
      starts,
      nearest,
      hint: this.hint,
    };
  }

  /** ?debug: the view plus how the last mission went and everything said. */
  debugState() {
    return { ...this.view(), last: this.last, said: [...this.said], missions: this.missions.map((m) => ({ id: m.id, title: m.title, start: this.startOf(m) })) };
  }

  private startOf(m: Mission): Place {
    return this.starts.get(m.id)!;
  }

  /** The host's shared mission, while it's running. */
  private following(): boolean {
    return !!this.mirrored?.state.id;
  }

  private nearestOf<T extends { x: number; z: number }>(targets: readonly T[]): T | null {
    let best: T | null = null;
    let bestD = Infinity;
    for (const t of targets) {
      const d = Math.hypot(t.x - this.me.x, t.z - this.me.z);
      if (d < bestD) [bestD, best] = [d, t];
    }
    return best;
  }

  /** Who a mission is for: the whole room if it's shared, else just us. */
  private playersOf(m: Mission): readonly MissionPlayer[] {
    return shared(m) ? [this.me, ...this.others] : [this.me];
  }

  private available(m: Mission): boolean {
    const players = this.playersOf(m);
    const { min, max } = m.players ?? { min: 1, max: 1 };
    if (players.length < min || players.length > max) return false;
    return m.available?.({ hour: HOUR, players }) ?? true;
  }

  /** Whether everyone a mission is for is at its marker. */
  private gathered(m: Mission): { all: boolean; here: number; of: number } {
    const start = this.startOf(m);
    const players = this.playersOf(m);
    const here = players.filter((p) => Math.hypot(start.x - p.x, start.z - p.z) < GATHER).length;
    return { all: here === players.length, here, of: players.length };
  }

  private idle(s: Snapshot): void {
    this.hint = '';
    for (const m of this.missions) {
      if (!this.available(m)) continue;
      const start = this.startOf(m);
      const d = Math.hypot(start.x - s.x, start.z - s.z);
      const radius = s.driving ? START_RADIUS.car : START_RADIUS.foot;
      if (d > radius + REARM) this.armed.set(m.id, true);
      const armed = this.armed.get(m.id) !== false;
      const crowd = this.gathered(m);
      if (d < HINT_RADIUS && !this.hint) {
        if (m.needsCar && !s.driving) this.hint = `${m.title}: bring a car`;
        else if (armed && !crowd.all) this.hint = `${m.title}: get everyone here (${crowd.here} of ${crowd.of})`;
        else if (armed) this.hint = `${m.title}: ${s.driving ? 'drive' : 'step'} into the marker`;
      }
      if (d < radius && armed && crowd.all && (!m.needsCar || s.driving) && this.grounded(s)) {
        if (!(shared(m) && this.guest)) {
          this.begin(m);
          return;
        }
        // The host runs it: ask (again, in case it was lost) until it starts.
        if (this.now - this.asked >= ASK_EVERY) {
          this.asked = this.now;
          this.requests.push(m.id);
        }
        this.hint = `${m.title}: starting…`;
      }
    }
  }

  private begin(mission: Mission): void {
    const run: Run = { mission, started: this.now, pending: [], guards: [], crash: [], deadlines: [], clock: null, targets: [], objective: '', shared: shared(mission) };
    this.run = run;
    this.armed.set(mission.id, false);
    this.subtitle = null;
    this.banner = { title: mission.title, text: mission.blurb, kind: 'start', until: this.now + CARD };
    if (run.shared) this.cueLog = [];
    this.cue(run, 'start');
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
    if (message || result === 'passed') this.cue(run, result);
    if (run.shared) {
      this.sharedLast = { n: (this.sharedLast?.n ?? 0) + 1, id: run.mission.id, result, message };
      this.sharingUntil = this.now + CARD;
    }
    this.subtitle = null;
    this.unwind(run);
  }

  /** Drop our own mission without a result: the host's shared one has started. */
  private abandon(run: Run): void {
    this.run = null;
    this.banner = this.subtitle = null;
    this.unwind(run);
  }

  private unwind(run: Run): void {
    const over = new MissionOver();
    for (const p of run.pending) p.reject(over);
    run.pending = [];
  }

  /** Guest: the room went (the host left, or we did) in the middle of their mission. */
  private lostHost(): void {
    const running = this.mirrored?.state.id;
    this.mirrored = null;
    this.heardCue = this.heardLast = 0;
    if (!running) return;
    const message = 'The getaway driver went home.';
    this.last = { id: running, result: 'failed', message };
    this.said.push(message);
    this.banner = { title: 'Mission failed!', text: message, kind: 'failed', until: this.now + CARD };
    this.cues.push('failed');
  }

  private cue(run: Run, cue: Cue): void {
    this.cues.push(cue);
    if (!run.shared) return;
    this.cueLog.push([++this.cueCount, cue]);
    if (this.cueLog.length > CUE_LOG) this.cueLog.shift();
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
    const resolve = (place: Place | string): Place => (typeof place === 'string' ? this.places.get(place) : place);
    // Repeatable per run: the same mission started at the same game time picks the same places.
    const rng = seeded(`${run.mission.id}@${run.started.toFixed(3)}`);
    const players = () => this.playersOf(run.mission);
    const reached = (place: Place, o: GoToOptions, p: MissionPlayer) =>
      Math.hypot(place.x - p.x, place.z - p.z) < (o.radius ?? DEFAULT_RADIUS) && (!o.inCar || p.driving) && this.grounded(p);
    /**
     * Resolves with the first of `among` to reach `place` (or with
     * `o.everyone`, the last of them once all still here are there at once).
     */
    const arrival = async (place: Place, o: GoToOptions, among: () => readonly MissionPlayer[], late = () => false): Promise<MissionPlayer | null> => {
      let who: MissionPlayer | null = null;
      await wait(() => {
        if (late()) return true;
        const ps = among();
        if (o.everyone) {
          const want = ps.filter((p) => o.everyone!.some((q) => q.id === p.id));
          if (want.length && want.every((p) => reached(place, o, p))) who = want[want.length - 1];
        } else who = ps.find((p) => reached(place, o, p)) ?? null;
        return !!who;
      });
      return who;
    };
    const mark = (place: Place, o: GoToOptions) => {
      if (!run.targets.includes(place)) run.targets.push(place);
      run.objective = o.label ?? `Go to ${place.name}`;
    };
    const unmark = (place: Place) => {
      if (this.run !== run || !run.targets.includes(place)) return;
      run.targets = run.targets.filter((p) => p !== place);
      if (!run.targets.length) run.objective = '';
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
        return players();
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
      place: (id) => this.places.get(id),
      nearest: (kind, near, q) => this.places.nearest(kind, near ?? this.me, q),
      random: (kind, q = {}) => this.places.random(kind, rng, { near: this.me, ...q }),
      goTo: async (target, o = {}) => {
        const place = resolve(target);
        mark(place, o);
        const who = (await arrival(place, o, players))!;
        unmark(place);
        this.cue(run, 'reached');
        return who;
      },
      race: async (racers, target, o) => {
        const place = resolve(target);
        mark(place, o);
        const at = this.now + o.seconds;
        let late = false;
        const c = clock(at, true, { at, expire: () => (late = true) });
        const who = await arrival(place, o, () => players().filter((p) => racers.some((r) => r.id === p.id)), () => late);
        c.stop();
        unmark(place);
        return late ? null : who;
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

/** For more than one: shared with the room. */
const shared = (m: Mission) => (m.players?.max ?? 1) > 1;

/** A small seeded PRNG (mulberry32 over an FNV-1a hash of `key`), 0..1. */
function seeded(key: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
