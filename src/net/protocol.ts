// What players send each other. Small JSON messages: poses at ~15 Hz,
// everything else rare. Guests talk only to the host, which relays (#26).

import type { SharedMission } from '../missions/runtime/runner.ts';

/** Bump when messages change shape, so old tabs get "please reload" instead of nonsense. */
export const PROTOCOL = 2;
/** Including the host. */
export const MAX_PLAYERS = 6;

/** Where a player is and what they're doing, sent ~15 times a second. */
export interface Pose {
  /** Sequence number: the data channel is unordered, so older ones are dropped. */
  s: number;
  /** Sender's game clock, s. */
  t: number;
  /** Driving this parked car (index into the map's parking), or -1 on foot. */
  c: number;
  /** Feet on foot, the body's centre in a car, m (rounded to cm). */
  p: [number, number, number];
  /** Car rotation (quaternion), in a car. */
  q?: [number, number, number, number];
  /** Heading on foot, radians. */
  h?: number;
  /** Velocity, m/s. */
  v: [number, number, number];
  /** On foot: grounded (0/1). In a car: [steer, throttle, brake, handbrake], for wheels and brake lights. */
  g?: number;
  d?: [number, number, number, number];
  /** Flying (cheat). */
  f?: number;
}

export interface Member {
  id: number;
  name: string;
}

export type Msg =
  /** Guest → host, first thing. */
  | { k: 'hello'; v: number; name: string; map: string }
  /** Host → new guest: your id, who's here, and where the host is (spawn next to them). */
  | { k: 'welcome'; id: number; members: Member[]; at: Pose | null }
  /** Host → guest: no. */
  | { k: 'reject'; why: string }
  /** Host → everyone: someone joined, left or renamed. */
  | { k: 'join'; m: Member }
  | { k: 'leave'; id: number }
  | { k: 'name'; id: number; name: string }
  /** A player's pose (the host stamps `id` when relaying). */
  | { k: 'pose'; id: number; pose: Pose }
  /** Host → guests, a few times a second: the shared mission (numbered: the channel is unordered). */
  | { k: 'mission'; s: number; st: SharedMission }
  /** Guest → host: I'm in this shared mission's marker, start it. */
  | { k: 'mstart'; id: string }
  /** Keeps a quiet link alive (a background tab draws no frames, so sends no poses). */
  | { k: 'hb' };

const cm = (n: number) => Math.round(n * 100) / 100;
const q4 = (n: number) => Math.round(n * 10000) / 10000;
export const roundVec = (x: number, y: number, z: number): [number, number, number] => [cm(x), cm(y), cm(z)];
export const roundQuat = (x: number, y: number, z: number, w: number): [number, number, number, number] => [q4(x), q4(y), q4(z), q4(w)];
export const round2 = q4;
