import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CITY_FORMAT, type CityManifest } from '../city/format.ts';
import { ChunkStreamer } from '../city/streamer.ts';
import type { GameMap, ParkingSpot } from './types.ts';

// The real Auckland CBD, generated offline by tools/citygen into
// public/city/<area>/ and streamed in by chunk: LiDAR terrain and OSM
// buildings so far; roads (T4) add their own per-chunk layer.

const AREA = 'cbd';
/** Ground within this radius of the spawn is loaded before play starts. */
const PRELOAD_RADIUS = 300;
/** Chassis centre above the ground for a car settled on its wheels, plus a little drop. */
const CAR_RIDE_HEIGHT = 0.9;

export async function loadAuckland(scene: THREE.Scene, world: RAPIER.World): Promise<GameMap> {
  const base = new URL(`city/${AREA}/`, new URL(import.meta.env.BASE_URL, location.href));
  const res = await fetch(new URL('manifest.json', base));
  if (!res.ok) throw new Error(`city manifest: HTTP ${res.status}`);
  const manifest = (await res.json()) as CityManifest;
  if (manifest.format !== CITY_FORMAT) throw new Error(`city data format ${manifest.format}, expected ${CITY_FORMAT}`);

  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const terrain = new ChunkStreamer(base, manifest, scene, world, ground);

  // Spawn on foot outside Britomart (the local origin). Proper kerbside
  // parking comes with the street data in T5; until then the cars sit on
  // the open ground nearby.
  const spawn = new THREE.Vector3(0, 0, 0);
  await terrain.ensureAround(spawn.x, spawn.z, PRELOAD_RADIUS);
  terrain.update(spawn.x, spawn.z);

  const heightAt = (x: number, z: number) => terrain.heightAt(x, z);
  const ensureLoaded = async (x: number, z: number) => {
    await terrain.ensureLoaded(x, z);
    terrain.update(x, z);
  };
  spawn.y = heightAt(spawn.x, spawn.z);

  const park = (x: number, z: number, heading: number, paint: number): ParkingSpot => ({
    pos: new THREE.Vector3(x, heightAt(x, z) + CAR_RIDE_HEIGHT, z),
    heading,
    paint,
  });
  const parking = [
    // Purple '95 Corolla, facing east with its driver's door (right side) towards you.
    park(spawn.x - 0.5, spawn.z - 2.2, 0, 0x7a3db8),
    park(spawn.x - 10, spawn.z - 2.4, 0, 0xe9e9e4),
    park(spawn.x - 12, spawn.z + 7, Math.PI, 0xa9adb3),
    park(spawn.x + 16, spawn.z + 9, Math.PI / 2, 0x6e1a24),
  ];

  const b = manifest.bounds;
  return {
    name: 'auckland',
    blurb: "Auckland CBD · purple '95 Corolla · real hills and buildings",
    // Late-afternoon haze: far enough to see across the CBD from the ridge.
    atmosphere: { sky: 0xf2b27a, fogNear: 250, fogFar: 1700, far: 2600 },
    parking,
    spawn: { feet: spawn, heading: 0 },
    heightAt,
    hasGround: (x, z) => !terrain.insideGrid(x, z) || terrain.hasCollider(x, z),
    clamp: (x, z) => ({
      x: THREE.MathUtils.clamp(x, b.minX + 5, b.maxX - 5),
      z: THREE.MathUtils.clamp(z, b.minZ + 5, b.maxZ - 5),
    }),
    ensureLoaded,
    update: (focus) => terrain.update(focus.x, focus.z),
    sync: () => {},
    debugInfo: () => terrain.stats(),
  };
}
