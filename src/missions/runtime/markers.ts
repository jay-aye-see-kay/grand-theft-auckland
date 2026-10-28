import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MissionView } from './runner.ts';

// Glowing rings on the street with a beam of light rising out of them, GTA
// III style: gold where a mission starts, pink for where to go. One mesh
// (one draw call) each, additive so they glow without lighting. Start
// markers show only nearby; the goal's beam is tall and ignores the fog so
// it reads over the rooftops from across the CBD.

const START = { colour: 0xffc23d, radius: 1.6, height: 5, draw: 300 };
const GOAL = { colour: 0xff5fc8, radius: 3, height: 220, draw: Infinity };
/** The goal widens with distance past this, so it's never a hairline across the city, m. */
const GOAL_WIDEN = 120;
/**
 * Before the ground under a far goal has streamed in, stand its beam this
 * far below the camera: the CBD's hills are within it, and the foot of the
 * beam is behind buildings at that range anyway, m.
 */
const UNKNOWN_GROUND = 40;

function beaconGeometry(radius: number, height: number): THREE.BufferGeometry {
  const ring = new THREE.RingGeometry(radius - 0.22, radius, 40, 1).rotateX(-Math.PI / 2).translate(0, 0.06, 0);
  const floor = new THREE.CircleGeometry(radius - 0.22, 40).rotateX(-Math.PI / 2).translate(0, 0.05, 0);
  const beam = new THREE.CylinderGeometry(radius * 0.92, radius * 0.92, height, 32, 8, true).translate(0, height / 2, 0);
  const parts = [ring, floor, beam].map((g) => g.toNonIndexed());
  const geo = mergeGeometries(parts.map((g) => {
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    return g;
  }))!;
  // Alpha by part and height: a bright rim, a faint floor, a beam fading upwards.
  const pos = geo.attributes.position;
  const colours = new Float32Array(pos.count * 4);
  const counts = parts.map((g) => g.attributes.position.count);
  for (let i = 0; i < pos.count; i++) {
    const part = i < counts[0] ? 0 : i < counts[0] + counts[1] ? 1 : 2;
    const h = pos.getY(i) / height;
    colours.set([1, 1, 1, part === 0 ? 1 : part === 1 ? 0.18 : 0.7 * (1 - h)], i * 4);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 4));
  return geo;
}

class Beacon {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;

  constructor(name: string, kind: typeof START, geometry: THREE.BufferGeometry) {
    this.material = new THREE.MeshBasicMaterial({
      color: kind.colour,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: kind === START,
      // Additive, so drawing order doesn't matter: one pass, not three's two for double-sided transparency.
      forceSinglePass: true,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = name;
    this.mesh.renderOrder = 2; // over the water and skid marks
    this.mesh.visible = false;
  }

  /** On the ground at (x, z), pulsing; hidden where the ground isn't known. */
  show(x: number, z: number, ground: number, clock: number, width = 1): void {
    this.mesh.visible = !Number.isNaN(ground);
    this.mesh.position.set(x, ground, z);
    this.mesh.scale.set(width, 1, width);
    this.material.opacity = 0.75 + 0.25 * Math.sin(clock * 4);
  }
}

export class MissionMarkers {
  readonly group = new THREE.Group();
  /** One per goal showing (a mission can mark a few places at once). */
  private readonly goals: Beacon[] = [];
  private readonly starts = new Map<string, Beacon>();
  private readonly startGeometry = beaconGeometry(START.radius, START.height);
  private readonly goalGeometry = beaconGeometry(GOAL.radius, GOAL.height);
  /** Ground under goals once it has streamed in: it may stream out again behind you. */
  private readonly heights = new Map<string, number>();

  constructor() {
    this.group.name = 'markers';
  }

  update(view: MissionView, heightAt: (x: number, z: number) => number, from: THREE.Vector3, clock: number): void {
    for (const [i, { x, z }] of view.targets.entries()) {
      let goal = this.goals[i];
      if (!goal) {
        goal = this.goals[i] = new Beacon(`marker goal ${i}`, GOAL, this.goalGeometry);
        this.group.add(goal.mesh);
      }
      const key = `${x},${z}`;
      const h = heightAt(x, z);
      if (!Number.isNaN(h)) this.heights.set(key, h);
      const ground = this.heights.get(key) ?? from.y - UNKNOWN_GROUND;
      goal.show(x, z, ground, clock, Math.max(1, Math.hypot(x - from.x, z - from.z) / GOAL_WIDEN));
    }
    for (const goal of this.goals.slice(view.targets.length)) goal.mesh.visible = false;
    for (const b of this.starts.values()) b.mesh.visible = false;
    for (const s of view.starts) {
      if (Math.hypot(s.x - from.x, s.z - from.z) > START.draw) continue;
      let b = this.starts.get(s.id);
      if (!b) {
        b = new Beacon(`marker start ${s.id}`, START, this.startGeometry);
        this.starts.set(s.id, b);
        this.group.add(b.mesh);
      }
      b.show(s.x, s.z, heightAt(s.x, s.z), clock);
    }
  }
}
