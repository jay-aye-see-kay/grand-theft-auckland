import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CITY_FORMAT, type CityManifest } from '../city/format.ts';
import { ChunkStreamer } from '../city/streamer.ts';
import type { GameMap, ParkingSpot } from './types.ts';

/** public/city/<area>/parking.json, written by tools/citygen/parking.ts. */
interface CityParking {
  spawn: { x: number; y: number; z: number; heading: number };
  cars: { osm: string; name: string; x: number; y: number; z: number; heading: number; pitch: number; roll: number; paint: number }[];
}

// The real Auckland CBD, generated offline by tools/citygen into
// public/city/<area>/ and streamed in by chunk: LiDAR terrain tinted by
// land use, OSM buildings, OSM roads draped on the terrain, and the harbour.

const AREA = 'cbd';
/**
 * Outside the map, the harbour is drawn only north of this z (local metres):
 * Westhaven to the west and the port to the east, but not the suburbs
 * beyond the southern edges.
 */
const SEA_SOUTH = 250;
/** Ground within this radius of the spawn is loaded before play starts. */
const PRELOAD_RADIUS = 300;

export async function loadAuckland(scene: THREE.Scene, world: RAPIER.World): Promise<GameMap> {
  const base = new URL(`city/${AREA}/`, new URL(import.meta.env.BASE_URL, location.href));
  const res = await fetch(new URL('manifest.json', base));
  if (!res.ok) throw new Error(`city manifest: HTTP ${res.status}`);
  const manifest = (await res.json()) as CityManifest;
  if (manifest.format !== CITY_FORMAT) throw new Error(`city data format ${manifest.format}, expected ${CITY_FORMAT}`);

  // Spawn and kerbside parking, posed offline from OSM roads and the terrain
  // (tools/citygen/parking.ts).
  const pres = await fetch(new URL('parking.json', base));
  if (!pres.ok) throw new Error(`city parking: HTTP ${pres.status}`);
  const parked = (await pres.json()) as CityParking;

  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const terrain = new ChunkStreamer(base, manifest, scene, world, ground);

  // On foot outside Britomart, next to the purple Corolla. Cars elsewhere
  // stay frozen (see main.ts) until the ground under them streams in.
  const s0 = parked.spawn;
  await terrain.ensureAround(s0.x, s0.z, PRELOAD_RADIUS);
  terrain.update(s0.x, s0.z);

  const heightAt = (x: number, z: number) => terrain.heightAt(x, z);
  const ensureLoaded = async (x: number, z: number) => {
    await terrain.ensureLoaded(x, z);
    terrain.update(x, z);
  };
  const spawn = new THREE.Vector3(s0.x, heightAt(s0.x, s0.z), s0.z);

  const parking: ParkingSpot[] = parked.cars.map((c) => ({
    pos: new THREE.Vector3(c.x, c.y, c.z),
    heading: c.heading,
    pitch: c.pitch,
    roll: c.roll,
    paint: c.paint,
  }));

  const b = manifest.bounds;
  return {
    name: 'auckland',
    blurb: "Auckland CBD · purple '95 sedan · real hills and buildings",
    // A clear afternoon: pale sea haze at the horizon under a deep blue sky,
    // far enough to see across the CBD from the ridge.
    atmosphere: { sky: 0xc9d7e3, zenith: 0x3d74b8, fogNear: 250, fogFar: 1800, far: 2600 },
    parking,
    spawn: { feet: spawn, heading: s0.heading },
    heightAt,
    hasGround: (x, z) => !terrain.insideGrid(x, z) || terrain.hasCollider(x, z),
    clamp: (x, z) => ({
      x: THREE.MathUtils.clamp(x, b.minX + 5, b.maxX - 5),
      z: THREE.MathUtils.clamp(z, b.minZ + 5, b.maxZ - 5),
    }),
    ensureLoaded,
    update: (focus) => terrain.update(focus.x, focus.z),
    sync: () => {},
    surfaceAt: (x, z) => terrain.surfaceAt(x, z),
    // The harbour bounds the map to the north; beyond its other edges is land.
    water: manifest.water && { level: manifest.water.level, bounds: b, seaSouth: SEA_SOUTH },
    nearest: (x, z, maxDist, ok) => terrain.nearest(x, z, maxDist, ok),
    // Performance budgets (CLAUDE.md) are measured from these three views.
    views: {
      // Street level at the spawn outside Britomart, looking west along Customs St.
      spawn: { from: [-8, 2.5, 22], at: [-120, 3, 12] },
      // Halfway up Queen St, looking uphill towards Wellesley St.
      'queen-st': { from: [-170, 2.5, 220], at: [-245, 6, 494] },
      // Over the harbour, looking across the whole CBD towards K Road.
      aerial: { from: [0, 250, -250], at: [-300, -4, 500] },
    },
    debugInfo: () => terrain.stats(),
  };
}
