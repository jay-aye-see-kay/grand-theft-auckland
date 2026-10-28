import type { Place } from './places.ts';

// The mission format: one file per mission in src/missions/, each exporting
// `defineMission({...})` as default. A mission's `run` is an async script
// against the small API below, so jokes can have logic and `npm run build`
// typechecks them. Grow the API as missions need it (see issue #27).
//
// Solo for now, but shaped for rooms (#26): scripts talk about `players`,
// and only the host will run them.

export interface MissionPlayer {
  readonly name: string;
  /** Where they are: feet on foot, the car's centre while driving. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly driving: boolean;
  readonly speedKmh: number;
}

/** What `available` can look at. */
export interface MissionContext {
  /** Local hour of day in the game (the sun is fixed mid-afternoon for now). */
  readonly hour: number;
  readonly players: readonly MissionPlayer[];
}

export interface GoToOptions {
  /** How close counts as there, m (default 6). */
  radius?: number;
  /** Objective line in the HUD (default "Go to <place>"). */
  label?: string;
  /** Only counts while driving. */
  inCar?: boolean;
}

/** A countdown or stopwatch shown at the top of the screen. */
export interface Clock {
  /** Seconds left (countdown) or gone (stopwatch). */
  readonly seconds: number;
  /** Stop and hide it. */
  stop(): void;
}

export interface MissionApi {
  readonly players: readonly MissionPlayer[];
  /** The local player (solo: the only one). */
  readonly player: MissionPlayer;
  /** Game seconds since the mission started. */
  readonly elapsed: number;
  /** A line of subtitle at the bottom of the screen. */
  say(text: string, seconds?: number): void;
  /** The objective line under the timer; '' clears it. */
  objective(text: string): void;
  /** Marks `place` (beam, arrow, objective line) and resolves when someone gets there. */
  goTo(place: Place, options?: GoToOptions): Promise<MissionPlayer>;
  /** goTo against the clock: who got there first, or null if time ran out. */
  race(players: readonly MissionPlayer[], place: Place, options: GoToOptions & { seconds: number }): Promise<MissionPlayer | null>;
  /** Resolves on the first tick `test` is true, with `label` as the objective meanwhile. */
  waitFor(test: () => boolean, label?: string): Promise<void>;
  /** Game seconds. */
  wait(seconds: number): Promise<void>;
  /** A countdown that fails the mission with `message` when it runs out. */
  timer(seconds: number, message: string): Clock;
  /** A stopwatch counting up. */
  stopwatch(): Clock;
  /** Fails the mission with `message` on any tick `test` is true, from now until it ends. */
  failIf(test: () => boolean, message: string): void;
  /** Called on each knock to the car you're driving, with how hard (sudden change of speed, m/s). */
  onCrash(fn: (strength: number) => void): void;
  /** Saves a best (lowest) time on this device, s. Whether this one beat it, and the best now. */
  record(seconds: number): { best: number; isNew: boolean };
  /** Ends the mission, passed. */
  succeed(message?: string): never;
  /** Ends the mission, failed. */
  fail(message: string): never;
}

export interface Mission {
  /** Also its file name. */
  readonly id: string;
  readonly title: string;
  /** Shown under the title when it starts. */
  readonly blurb: string;
  readonly players?: { min: number; max: number };
  /** Whether its start marker shows (default: always). */
  available?(ctx: MissionContext): boolean;
  /** Where its start marker is: walk (or drive) into it to start. */
  readonly start: Place;
  /** Only starts when you drive into the marker. */
  readonly needsCar?: boolean;
  run(m: MissionApi): Promise<void>;
}

/** Identity, for type checking and editor help in mission files. */
export const defineMission = (mission: Mission): Mission => mission;

/** Mission time as m:ss, or m:ss.t with `tenths`. */
export const formatTime = (seconds: number, tenths = false): string => {
  const s = Math.max(0, seconds);
  const whole = tenths ? Math.floor(s * 10) / 10 : Math.ceil(s);
  const m = Math.floor(whole / 60);
  const rest = whole - m * 60;
  return `${m}:${rest.toFixed(tenths ? 1 : 0).padStart(tenths ? 4 : 2, '0')}`;
};
