import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { BuildingMesh } from './format.ts';

// One chunk's buildings (or roads, same format): the render arrays, which
// ChunkMesh merges with the chunk's terrain into one draw call, and one
// static trimesh collider (walls and roofs; for roads, bridge decks), which
// only chunks near the player have. Roads carry a per-vertex draw layer
// (see roadMaterial).

/**
 * Collision groups (membership << 16 | filter). Buildings are in group 1 and
 * collide with everything; queries that want bare terrain (the debug probe)
 * filter on group 0, which buildings aren't in.
 */
export const BUILDING_GROUPS = (0x0002 << 16) | 0xffff;
export const TERRAIN_ONLY_QUERY = (0xffff << 16) | 0x0001;

export class BuildingChunk {
  /** Render vertices, relative to the chunk centre. */
  readonly pos: Float32Array;
  readonly normals: Int8Array;
  readonly colours: Uint8Array;
  readonly layers: Uint8Array | undefined;
  readonly indices: Uint32Array;
  private collider: RAPIER.Collider | null = null;
  private readonly vertices: Float32Array;
  private readonly colliderIndices: Uint32Array;

  /** @param cx, cz the chunk centre in local metres (the file's origin) */
  constructor(data: BuildingMesh, cx: number, cz: number) {
    const n = data.xCm.length;
    const pos = new Float32Array(n * 3);
    const base = data.baseCm / 100;
    for (let k = 0; k < n; k++) {
      pos[k * 3] = data.xCm[k] / 100;
      pos[k * 3 + 1] = base + data.yCm[k] / 100;
      pos[k * 3 + 2] = data.zCm[k] / 100;
    }
    this.pos = pos;
    this.normals = data.normals;
    this.colours = data.colours;
    this.layers = data.layers;
    this.indices = data.indices;

    // The collider lives on the shared fixed body, so it needs world positions.
    this.vertices = new Float32Array(pos);
    for (let k = 0; k < n; k++) {
      this.vertices[k * 3] += cx;
      this.vertices[k * 3 + 2] += cz;
    }
    this.colliderIndices = data.colliderIndices;
  }

  get count(): number {
    return this.pos.length / 3;
  }

  get hasCollider(): boolean {
    return this.collider !== null;
  }

  addCollider(world: RAPIER.World, body: RAPIER.RigidBody): void {
    if (this.collider || !this.colliderIndices.length) return;
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.trimesh(this.vertices, this.colliderIndices)
        .setCollisionGroups(BUILDING_GROUPS)
        .setFriction(0.5)
        .setRestitution(0.05),
      body,
    );
  }

  removeCollider(world: RAPIER.World): void {
    if (this.collider) world.removeCollider(this.collider, false);
    this.collider = null;
  }
}

/**
 * Depth bias per road draw layer, in normalised device depth. Overlapping
 * road surfaces (paving < footpath < road < kerb) already sit a few cm apart,
 * which is plenty up close; further out that falls below the depth buffer's
 * precision (about d^2 / 2^24 / near), so each layer is also pulled towards
 * the camera by this much: about 3 cm per layer at 100 m, 30 cm at 300 m.
 */
const ROAD_DEPTH_BIAS = 2e-6;

/** Lambert with vertex colours, plus the per-layer depth bias for road surfaces. */
export function roadMaterial(): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float roadLayer;')
      .replace('#include <project_vertex>', `#include <project_vertex>\ngl_Position.z -= roadLayer * ${ROAD_DEPTH_BIAS.toExponential()} * gl_Position.w;`);
  };
  material.customProgramCacheKey = () => 'road-layers';
  return material;
}
