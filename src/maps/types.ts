import type * as THREE from 'three';
import type { Gazetteer } from '../missions/runtime/places.ts';

// What the game loop needs from a map. The test town and Auckland both
// implement it; main.ts never knows which one it's running.

export interface ParkingSpot {
  /** Car body position (chassis centre, a little above the ground). */
  pos: THREE.Vector3;
  /** 0 faces +x (east), PI/2 faces -z (north). */
  heading: number;
  /** Nose up and left side up, radians, so it sits flush on a slope (default level). */
  pitch?: number;
  roll?: number;
  paint: number;
}

export interface Atmosphere {
  /** Haze at the horizon: the fog and the bottom of the sky dome. */
  sky: number;
  /** Top of the sky dome (default a soft blue). */
  zenith?: number;
  fogNear: number;
  fogFar: number;
  /** Camera far plane, m. */
  far: number;
}

/**
 * A fixed camera for ?debug screenshots and the smoke test's performance
 * budgets. Heights are metres above the ground under each point.
 */
export interface DebugView {
  from: [number, number, number];
  at: [number, number, number];
}

export interface GameMap {
  readonly name: string;
  /** Splash-screen subtitle. */
  readonly blurb: string;
  readonly atmosphere: Atmosphere;
  /** Parked cars; the first is the player's purple Corolla. */
  readonly parking: ParkingSpot[];
  /** Where the player starts, on foot (feet position). */
  readonly spawn: { feet: THREE.Vector3; heading: number };
  /** Ground (terrain) height at a point, NaN where nothing is loaded. */
  heightAt(x: number, z: number): number;
  /**
   * False while the ground under this point is still streaming in. Bodies
   * there are frozen so they don't fall through the world.
   */
  hasGround(x: number, z: number): boolean;
  /** Nearest point inside the playable area (for rescuing cars that fall off the edge). */
  clamp(x: number, z: number): { x: number; z: number };
  /** Resolves once the ground under (x, z) has collision. */
  ensureLoaded(x: number, z: number): Promise<void>;
  /** Per frame: stream content around the focus point. */
  update(focus: THREE.Vector3): void;
  /** After physics: move dynamic props' visuals. */
  sync(): void;
  /** Surface under a point ('road', 'footpath', 'grass', ...), null if unknown or not loaded. */
  surfaceAt?(x: number, z: number): string | null;
  /** Tree canopy over a point, 0..1 (debug probe). */
  canopyAt?(x: number, z: number): number | null;
  /**
   * Open water: a sea-level plane wherever the ground is lower. Outside the
   * map's bounds it's drawn only north of `seaSouth` (the harbour side).
   */
  readonly water?: { level: number; bounds: { minX: number; minZ: number; maxX: number; maxZ: number }; seaSouth: number };
  /**
   * The nearest loaded ground point within `maxDist` of (x, z) that `ok`
   * accepts (given its surface and height), or null.
   */
  nearest?(x: number, z: number, maxDist: number, ok: (x: number, z: number, surface: string, height: number) => boolean): { x: number; z: number } | null;
  /** Named reproducible camera views (?debug): budgets are measured from these. */
  readonly views?: Record<string, DebugView>;
  /** Hand-made landmarks: where they are, how tall, which detail is drawn (?debug and the smoke test). */
  landmarks?(): { id: string; name: string; x: number; z: number; base: number; height: number; top: number; lod: string; triangles: { near: number; far: number }; colliders: number; replaces: boolean }[];
  /** Named places for missions (real maps only: missions are set on real streets). */
  readonly places?: Gazetteer;
  /** Extra numbers for ?debug and the smoke test. */
  debugInfo(): Record<string, number>;
}
