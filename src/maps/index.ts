import type RAPIER from '@dimforge/rapier3d-compat';
import type * as THREE from 'three';
import { loadAuckland } from './auckland.ts';
import { buildTestTown } from './test-town.ts';
import type { GameMap } from './types.ts';

export type { GameMap, ParkingSpot } from './types.ts';

/** Auckland by default; `?map=test` for the old placeholder town. */
export async function loadMap(name: string | null, scene: THREE.Scene, world: RAPIER.World, maxAnisotropy = 1): Promise<GameMap> {
  if (name === 'test') return buildTestTown(scene, world);
  return loadAuckland(scene, world, maxAnisotropy);
}
