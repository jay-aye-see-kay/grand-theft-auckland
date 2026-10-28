import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Car, DriveControls } from '../car.ts';
import { Player } from '../player.ts';
import type { MissionPlayer } from '../missions/runtime/mission.ts';
import type { Pose } from './protocol.ts';

// Other players in the room, as we see them: a little behind real time
// (interpolating between their poses, so jittery packets still look
// smooth), as kinematic bodies our car bumps off. Someone driving one of the
// parked cars takes it over on our screen too: it turns kinematic and
// follows their pose until they get out, then it's an ordinary parked car
// again, left where they parked it.

/** Show others this far behind their latest pose: two packets at 15 Hz plus jitter, s. */
const DELAY = 0.12;
/** Past their latest pose (packets late), carry on along their velocity at most this long, s. */
const EXTRAPOLATE = 0.25;
/** Poses kept per player. */
const BUFFER = 24;
/** The clock offset is the smallest (their clock − ours) gap over this many recent poses. */
const OFFSET_WINDOW = 30;
/** Name tags over heads, m above the feet (or the car's centre). */
const TAG_LIFT = { foot: 2.0, car: 1.5 };
/** Hide name tags beyond this from the camera, m. */
const TAG_RANGE = 800;
/** Draw others' people within this of the camera, m. */
const PERSON_DRAW = 300;

interface Remote {
  id: number;
  name: string;
  poses: Pose[];
  seq: number;
  gaps: number[];
  offset: number;
  puppet: Player;
  /** The parked car they're driving on our screen, or -1. */
  car: number;
  controls: DriveControls;
  tag: HTMLElement;
  /** Where they are now, as drawn (for tags and the debug hooks). */
  at: THREE.Vector3;
  /** Has anything to show yet. */
  seen: boolean;
  /** As drawn: in a car, and how fast, km/h (for missions). */
  driving: boolean;
  speedKmh: number;
}

const _q = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export class Remotes {
  private readonly world: RAPIER.World;
  private readonly scene: THREE.Scene;
  private readonly cars: readonly Car[];
  private readonly tags: HTMLElement;
  private readonly remotes = new Map<number, Remote>();
  /** Which remote drives each car. */
  private readonly drivers = new Map<number, Remote>();
  /** Someone with a better claim got into the car we're driving: get out. */
  onEvicted: () => void = () => {};

  constructor(world: RAPIER.World, scene: THREE.Scene, cars: readonly Car[], hud: HTMLElement) {
    this.world = world;
    this.scene = scene;
    this.cars = cars;
    this.tags = document.createElement('div');
    this.tags.className = 'name-tags';
    hud.appendChild(this.tags);
  }

  add(id: number, name: string): void {
    if (this.remotes.has(id)) return this.rename(id, name);
    const puppet = new Player(this.world, new THREE.Vector3(0, -100, 0));
    puppet.object.traverse((o) => (o.name = 'remote'));
    puppet.object.visible = false;
    puppet.collider.setEnabled(false);
    this.scene.add(puppet.object);
    const tag = document.createElement('div');
    tag.className = 'name-tag hidden';
    tag.textContent = name;
    this.tags.appendChild(tag);
    this.remotes.set(id, {
      id, name, poses: [], seq: -1, gaps: [], offset: 0, puppet, car: -1,
      controls: { steer: 0, throttle: 0, brake: 0, handbrake: false }, tag, at: new THREE.Vector3(), seen: false, driving: false, speedKmh: 0,
    });
  }

  rename(id: number, name: string): void {
    const r = this.remotes.get(id);
    if (!r) return;
    r.name = name;
    r.tag.textContent = name;
  }

  remove(id: number): void {
    const r = this.remotes.get(id);
    if (!r) return;
    this.release(r);
    this.scene.remove(r.puppet.object);
    r.puppet.dispose(this.world);
    r.tag.remove();
    this.remotes.delete(id);
  }

  clear(): void {
    for (const id of [...this.remotes.keys()]) this.remove(id);
  }

  receive(id: number, pose: Pose, clock: number): void {
    const r = this.remotes.get(id);
    if (!r || pose.s <= r.seq) return; // unordered channel: a late one is stale
    r.seq = pose.s;
    // Their clock against ours: the smallest recent gap is the least delayed packet.
    r.gaps.push(clock - pose.t);
    if (r.gaps.length > OFFSET_WINDOW) r.gaps.shift();
    r.offset = Math.min(...r.gaps);
    r.poses.push(pose);
    if (r.poses.length > BUFFER) r.poses.shift();
  }

  /** The car a remote player is driving on our screen (their controls), or null. */
  controlsFor(car: Car): DriveControls | null {
    return this.drivers.get(this.cars.indexOf(car))?.controls ?? null;
  }

  drives(car: Car): boolean {
    return this.drivers.has(this.cars.indexOf(car));
  }

  /**
   * Each fixed tick, before world.step(): send everyone's body to where they
   * were DELAY ago. `driving` is the car we're in (index, or -1), `myId` our
   * id (lower ids win a car both got into), `solid` whether their people
   * should block ours (only while we're on foot: a car hitting an immovable
   * person would stop dead).
   */
  beforeStep(clock: number, driving: number, myId: number, solid: boolean): void {
    for (const r of this.remotes.values()) {
      const pose = this.sample(r, clock - r.offset - DELAY);
      if (!pose) continue;
      r.seen = true;
      if (pose.c !== r.car) {
        this.release(r);
        if (pose.c >= 0 && pose.c < this.cars.length) {
          if (pose.c === driving && r.id < myId) this.onEvicted();
          if (pose.c !== driving || r.id < myId) this.claim(r, pose.c);
        }
      }
      const [x, y, z] = pose.p;
      r.at.set(x, y, z);
      r.driving = pose.c >= 0;
      r.speedKmh = Math.hypot(...pose.v) * 3.6;
      if (r.car >= 0 && pose.q) {
        const body = this.cars[r.car].body;
        body.setNextKinematicTranslation({ x, y, z });
        body.setNextKinematicRotation({ x: pose.q[0], y: pose.q[1], z: pose.q[2], w: pose.q[3] });
        const d = pose.d ?? [0, 0, 0, 0];
        r.controls.steer = d[0];
        r.controls.throttle = d[1];
        r.controls.brake = d[2];
        r.controls.handbrake = d[3] > 0;
      }
      const onFoot = pose.c < 0;
      r.puppet.object.visible = onFoot;
      r.puppet.collider.setEnabled(onFoot && solid && !pose.f);
      if (onFoot) r.puppet.follow(x, y, z, pose.h ?? 0, Math.hypot(pose.v[0], pose.v[2]), !!pose.g || !!pose.f);
    }
  }

  /** After world.step(). */
  afterStep(): void {
    for (const r of this.remotes.values()) r.puppet.afterStep();
  }

  /** Draw their people and put name tags over everyone. */
  render(alpha: number, dt: number, camera: THREE.PerspectiveCamera): void {
    const w = document.documentElement.clientWidth;
    const h = document.documentElement.clientHeight;
    camera.getWorldDirection(_fwd);
    for (const r of this.remotes.values()) {
      const inCar = r.car >= 0;
      if (!inCar && r.seen) {
        r.puppet.render(alpha, dt);
        r.puppet.object.visible = r.puppet.position.distanceTo(camera.position) < PERSON_DRAW;
      }
      const base = inCar ? this.cars[r.car].object.position : r.puppet.position;
      _v.copy(base).setY(base.y + (inCar ? TAG_LIFT.car : TAG_LIFT.foot));
      const d = _v.distanceTo(camera.position);
      const ahead = _v.clone().sub(camera.position).dot(_fwd) > 0;
      const show = r.seen && ahead && d < TAG_RANGE;
      r.tag.classList.toggle('hidden', !show);
      if (!show) continue;
      _v.project(camera);
      const text = d > 60 ? `${r.name} · ${Math.round(d / 10) * 10} m` : r.name;
      if (r.tag.textContent !== text) r.tag.textContent = text;
      r.tag.style.transform = `translate(${(((_v.x + 1) / 2) * w).toFixed(0)}px, ${(((1 - _v.y) / 2) * h).toFixed(0)}px) translate(-50%, -100%)`;
    }
  }

  /** Everyone else, where we draw them, for the missions the host runs (only those we've seen). */
  players(): MissionPlayer[] {
    const out: MissionPlayer[] = [];
    for (const r of this.remotes.values()) {
      if (r.seen) out.push({ id: r.id, name: r.name, x: r.at.x, y: r.at.y, z: r.at.z, driving: r.driving, speedKmh: r.speedKmh });
    }
    return out;
  }

  /** For ?debug: where each remote player is, and which car they're in. */
  debug(): { id: number; name: string; at: number[]; car: number; poses: number }[] {
    return [...this.remotes.values()].map((r) => ({ id: r.id, name: r.name, at: r.at.toArray(), car: r.car, poses: r.poses.length }));
  }

  /** Their pose at `t` on their clock: between the two poses either side, or a little past the last. */
  private sample(r: Remote, t: number): Pose | null {
    const ps = r.poses;
    if (!ps.length) return null;
    if (t <= ps[0].t) return ps[0];
    for (let i = ps.length - 1; i > 0; i--) {
      const a = ps[i - 1];
      const b = ps[i];
      if (t < a.t) continue;
      if (t > b.t) break;
      return lerpPose(a, b, (t - a.t) / Math.max(b.t - a.t, 1e-6));
    }
    const last = ps[ps.length - 1];
    const ahead = Math.min(t - last.t, EXTRAPOLATE);
    if (ahead <= 0) return last;
    return { ...last, p: [last.p[0] + last.v[0] * ahead, last.p[1] + last.v[1] * ahead, last.p[2] + last.v[2] * ahead] };
  }

  private claim(r: Remote, index: number): void {
    const prev = this.drivers.get(index);
    if (prev) prev.car = -1;
    const body = this.cars[index].body;
    body.setEnabled(true);
    body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    this.drivers.set(index, r);
    r.car = index;
  }

  /**
   * They got out (or left): an ordinary parked car again, where they left it
   * (their last pose in it, which we may not have shown yet if packets
   * bunched up), rolling on as it was.
   */
  private release(r: Remote): void {
    if (r.car < 0) return;
    const body = this.cars[r.car].body;
    if (this.drivers.get(r.car) === r) {
      body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      let last: Pose | undefined;
      for (const p of r.poses) if (p.c === r.car && p.q) last = p;
      if (last) {
        body.setTranslation({ x: last.p[0], y: last.p[1], z: last.p[2] }, true);
        body.setRotation({ x: last.q![0], y: last.q![1], z: last.q![2], w: last.q![3] }, true);
        body.setLinvel({ x: last.v[0], y: last.v[1], z: last.v[2] }, true);
      }
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.drivers.delete(r.car);
    }
    r.car = -1;
  }
}

function lerpPose(a: Pose, b: Pose, k: number): Pose {
  const p: [number, number, number] = [a.p[0] + (b.p[0] - a.p[0]) * k, a.p[1] + (b.p[1] - a.p[1]) * k, a.p[2] + (b.p[2] - a.p[2]) * k];
  // In or out of a car between the two: stay with the earlier until the later.
  if (a.c !== b.c) return k < 1 ? a : b;
  const out: Pose = { ...a, p };
  if (a.q && b.q) {
    _q.set(...a.q).slerp(_qb.set(...b.q), k);
    out.q = [_q.x, _q.y, _q.z, _q.w];
  }
  if (a.h !== undefined && b.h !== undefined) out.h = a.h + Math.atan2(Math.sin(b.h - a.h), Math.cos(b.h - a.h)) * k;
  return out;
}
